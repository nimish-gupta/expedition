import * as Sequelize from 'sequelize'
import * as Bluebird from 'bluebird'

export interface EventAttributes {
  session: number;
  client: string;
  timestamp: Date;
  id?: number|null;
  type: string;
  json?: string|null;
}

export interface EventInstance extends Sequelize.Instance<EventAttributes> {
  dataValues: EventAttributes;
}

export type EventModel = Sequelize.Model<EventInstance, EventAttributes>;

export class Event {
  protected s: Sequelize.Sequelize;
  public model: EventModel;

  constructor(s: Sequelize.Sequelize) {
    this.s = s;
    this.model = (this.s.define('Events', {
      session: {
        type: Sequelize.BIGINT,
        allowNull: false,
        primaryKey: true,
      },
      client: {
        type: Sequelize.STRING(255),
        allowNull: false,
        primaryKey: true,
      },
      timestamp: {
        type: Sequelize.DATE,
        allowNull: false,
        primaryKey: true,
      },
      id: {
        type: Sequelize.BIGINT,
      },
      type: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      json: {
        type: Sequelize.TEXT(),
      },
    }, {
      timestamps: true,
      underscored: true,
    }) as EventModel);
  }

  public associate(models: any) {}

  public upsert(attrs: EventAttributes): Bluebird<void> {
    return this.model.upsert(attrs).then(()=>{});
  }

  public getLast(session: number): Bluebird<EventInstance|null> {
    return this.model.findOne({
      where: {session} as any,
      order: [['created_at', 'DESC']]
    });
  }
}

