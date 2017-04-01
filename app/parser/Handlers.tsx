import * as React from 'react'
import {XMLElement, DOMElement} from '../reducers/StateTypes'
import {Choice, defaultQuestContext, Enemy, EventParameters, RoleplayElement, QuestCardName, QuestContext} from '../reducers/QuestTypes'
import {encounters} from '../Encounters'
import {isEnabled, findRootNode, loopChildren, findNextNode} from './Node'
import {evaluateOp, evaluateContentOps, updateContext, parseOpString} from './Context'

const Cheerio = require('cheerio');
const Clone = require('clone');
const HtmlDecode = (require('he') as any).decode;
const Math = require('mathjs') as any;

export interface CombatResult {
  type: 'Combat';
  icon: string;
  enemies: Enemy[];
  ctx: QuestContext;
}

export interface RoleplayResult {
  type: 'Roleplay';
  icon: string;
  title: string;
  content: RoleplayElement[];
  choices: Choice[];
  ctx: QuestContext;
}

export interface TriggerResult {
  type: 'Trigger';
  node: XMLElement;
  name: string;
}

// The passed event parameter is a string indicating which event to fire based on the "on" attribute.
// Returns the event element itself; handy for getting event parameters
export function getEvent(parent: XMLElement, event: string, ctx: QuestContext): XMLElement {
  const child = loopChildren(parent, (tag: string, c: XMLElement) => {
    if (c.attr('on') === event && isEnabled(c, ctx)) {
      return c;
    }
  });

  if (!child) {
    throw new Error('Could not find child with on="' + event + '"');
  }
  return child;
};

// The passed event parameter is a string indicating which event to fire based on the "on" attribute.
// Returns the (cleaned) parameters of the event element
export function getEventParameters(parent: XMLElement, event: string, ctx: QuestContext): EventParameters {
  const node = getEvent(parent, event, ctx).get(0);
  const cheeriod = Cheerio(node).get(0);
  // TODO this is a hack b/c QC and app don't currently init quest with the same XML format
  // from Quest Creator
  // https://github.com/ExpeditionRPG/expedition-app/issues/245
  if (cheeriod) {
    return cleanParams(cheeriod.attribs);
  // from App
  } else {
    const params: any = {};
    const attributes = node.attributes;
    for (let i = 0; i < attributes.length; i++) {
      params[attributes[i].name] = attributes[i].value;
    }
    return cleanParams(params);
  }

  function cleanParams(obj: any): EventParameters {
    const ret: EventParameters = {};
    if (obj.xp) { ret.xp = (obj.xp == 'true'); }
    if (obj.loot) { ret.loot = (obj.loot == 'true'); }
    if (obj.heal) { ret.heal = parseInt(obj.heal); }
    return ret;
  }
}

// The passed choice parameter is an number indicating the choice number in the XML element, including conditional choices.
export function handleChoice(parent: XMLElement, choice: number, ctx: QuestContext): XMLElement {

  // Scan the parent node to find the choice with the right number
  let choiceIdx = -1;
  for (let idx = 0; idx < parent.children().length; idx++) {
    const child = parent.children().eq(idx);
    if (child.get(0).tagName.toLowerCase() === 'choice' && isEnabled(child, ctx)) {
      choiceIdx++;
    }

    // When we find our choice, push it onto the stack and load it.
    if (choiceIdx === choice) {
      if (!isEnabled(child, ctx)) {
        throw new Error('Somehow triggered an invisible choice node');
      }
      return loadChoiceOrEventNode(child, ctx);
    }
  }

  // This happens on lookup error or default "Next"/"End" event
  if (loopChildren(parent, (tag) => { if (tag === 'end') { return true; }})) {
    return null;
  }
  return findNextNode(parent, ctx);
}

// The passed event parameter is a string indicating which event to fire based on the "on" attribute.
// Returns the card inside of / referenced by the event element
export function handleEvent(parent: XMLElement, event: string, ctx: QuestContext): XMLElement {
  const child = getEvent(parent, event, ctx);
  return loadChoiceOrEventNode(child, ctx);
}

export function loadCombatNode(node: XMLElement, ctx: QuestContext): CombatResult {
  let enemies: Enemy[] = [];

  const newContext = updateContext(node, ctx);

  // Track win and lose events for validation
  let winEventCount = 0;
  let loseEventCount = 0;
  loopChildren(node, (tag: string, c: XMLElement) => {

    // Skip events and enemies that aren't enabled.
    if (!isEnabled(c, newContext)) {
      return;
    }

    switch (tag) {
      case 'e':
        let text = c.text();

        // Replace text if it's an op string.
        // If the string fails to evaluate, the original op is returned as text.
        const op = parseOpString(text);
        if (op) {
          const evalResult = evaluateOp(op, newContext);
          if (evalResult) {
            text = evalResult + '';
          }
        }

        const encounter = encounters[text.toLowerCase()];

        if (!encounter) {
          // If we don't know about the enemy, just assume tier 1.
          enemies.push({name: text, tier: 1});
        } else {
          enemies.push({name: encounter.name, tier: encounter.tier, class: encounter.class});
        }
        break;
      case 'event':
        switch (c.attr('on')) {
          case 'win':
            winEventCount++;
            break;
          case 'lose':
            loseEventCount++;
            break;
        }
        break;
      default:
        throw new Error('Invalid child element: ' + tag);
    }
  });

  if (winEventCount === 0) {
    throw new Error('<combat> must have at least one conditionally true child with on="win"');
  }

  if (loseEventCount === 0) {
    throw new Error('<combat> must have at least one conditionally true child with on="lose"');
  }

  if (!enemies.length) {
    throw new Error('<combat> has no <e> children');
  }

  // Combat is stateless, so newContext is not returned here.
  return {
    type: 'Combat',
    icon: node.attr('icon'),
    enemies,
    ctx,
  };
}

export function loadRoleplayNode(node: XMLElement, ctx: QuestContext): RoleplayResult {
  // Append elements to contents
  let numEvents = 0;
  let choices: Choice[] = [];
  let choiceCount = -1;
  let children: RoleplayElement[] = [];

  const newContext = updateContext(node, ctx);

  loopChildren(node, (tag: string, c: XMLElement) => {
    c = c.clone();

    // Skip elements that aren't visible
    if (!isEnabled(c, newContext)) {
      return;
    }

    // Accumulate 'choice' tags in choices[]
    if (tag === 'choice') {
      choiceCount++;
      if (!c.attr('text')) {
        throw new Error('<choice> inside <roleplay> must have "text" attribute');
      }
      const text = c.attr('text');
      choices.push({text: generateIconElements(evaluateContentOps(text, newContext)), idx: choiceCount});
      numEvents++;
      return;
    }

    if (tag === 'event') {
      throw new Error('<roleplay> cannot contain <event>.');
    }

    const element: RoleplayElement = {
      type: 'text',
      text: '',
    }
    if (tag === 'instruction') {
      element.type = 'instruction';
      element.text = c.html();
    } else { // text
      // If we received a Cheerio object, outerHTML will
      // not be defined. toString will be, however.
      // https://github.com/cheeriojs/cheerio/issues/54
      if (c.get(0).outerHTML) {
        element.text = c.get(0).outerHTML;
      } else if (c.toString) {
        element.text = c.toString();
      } else {
        throw new Error('Invalid element ' + c);
      }
    }

    element.text = generateIconElements(evaluateContentOps(element.text, newContext));

    if (element.text !== '') {
      children.push(element);
    }
  });

  // Append a generic 'Next' button if there were no events,
  // or an 'End' button if there's also an <End> tag.
  if (numEvents === 0) {
    // Handle custom generic next button text based on if we're heading into a trigger node.
    const nextNode = findNextNode(node, ctx);
    let buttonText = 'Next';
    if (nextNode && nextNode.get(0).tagName.toLowerCase() === 'trigger') {
      switch(nextNode.text().toLowerCase()) {
        case 'end':
          buttonText = 'End';
          break;
      }
    }
    choices.push({text: buttonText, idx: 0});
  }

  return {
    type: 'Roleplay',
    title: node.attr('title'),
    icon: node.attr('icon'),
    content: children,
    choices,
    ctx: newContext,
  };
}

export function loadTriggerNode(node: XMLElement): TriggerResult {
  const text = node.text().trim();
  if (text === 'end') {
    return {
      type: 'Trigger',
      node,
      name: 'end',
    };
  }

  const m = text.match(/\s*goto\s+(.*)/);
  if (m) {
    const id = m[1];

    // Return the destination element with that id.
    return {
      type: 'Trigger',
      node: findRootNode(node).find('#'+id).eq(0),
      name: 'goto',
    };
  }

  throw new Error('invalid trigger ' + text);
}


// Replaces [icon_name] with <img class="inline_icon" src="images/icon_name.svg">
function generateIconElements(content: string): string {
  // \[([a-zA-Z_0-9]*)\]   Contents inside of []'s, only allowing for alphanumeric + _'s
  // /g                    Multiple times
  return content.replace(/\[([a-zA-Z_0-9]*)\]/g, (match:string, group:string): string => {
    return `<img class="inline_icon" src="images/${group}_small.svg">`;
  });
}

function loadChoiceOrEventNode(node: XMLElement, ctx: QuestContext): XMLElement {
  // If there's only one child and it's a trigger, activate it immediately
  const children = node.children();
  if (children.length === 1 && children.get(0).tagName === 'trigger') {
    return loadTriggerNode(children.eq(0)).node;
  }

  const child: any = loopChildren(node, (tag, n) => {
    if (tag === 'event' || tag === 'choice') {
      throw new Error('Node cannot have <event> or <choice> child');
    }

    if ((tag === 'combat' || tag === 'trigger' || tag === 'roleplay') && isEnabled(n, ctx)) {
      return n;
    }
  });

  if (!child) {
    throw new Error('Node without goto attribute must have at least one of <combat> or <roleplay> or <trigger>');
  }

  // Dive in to the first element.
  return loadNode(child);
}

function loadNode(node: XMLElement): XMLElement {
  switch(node.get(0).tagName.toLowerCase()) {
    case 'combat':
    case 'roleplay':
    case 'trigger':
      return node;
    default:
      throw new Error('Unknown or unexpected node: ' + node.get(0).tagName);
  }
}
