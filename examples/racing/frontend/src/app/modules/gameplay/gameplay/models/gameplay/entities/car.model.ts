import { Vector2 } from 'three';
import { BehaviorSubject } from 'rxjs';
import CarCharacteristicsModel from '../helpers/car-characteristics.model';
import CarPositioningModel from '../world/car-positioning.model';
import { CarData } from '../../../../../api/interfaces/car.interfaces';

export default class Car {

  public positionChangedSubject: BehaviorSubject<Vector2>;
  public rotationChangedSubject: BehaviorSubject<number>;
  public speedChangedSubject: BehaviorSubject<number>;

  constructor(public model: string,
              public characteristics: CarCharacteristicsModel,
              public x: number = 0,
              public y: number = 0,
              public rotation: number = 0,
              private _speed: number = 0) {
    this.positionChangedSubject = new BehaviorSubject<Vector2>(new Vector2(x, y));
    this.rotationChangedSubject = new BehaviorSubject<number>(rotation);
    this.speedChangedSubject = new BehaviorSubject<number>(_speed);
  }

  get speed(): number {
    return this._speed;
  }

  set speed(value: number) {
    if (value === this._speed) {
      return;
    }
    this._speed = value;
    this.speedChangedSubject.next(value);
  }

  static fromDTO(carDTO: CarData): Car {
    return new Car('lambo_aventador', CarCharacteristicsModel.fromDTO(carDTO));
  }

  getPosition(): Vector2 {
    return new Vector2(this.x, this.y);
  }

  getFullPositioning(): CarPositioningModel {
    return new CarPositioningModel(
      this.getPosition(),
      this.rotation,
      this.speed
    );
  }

  setFullPositioning(value: CarPositioningModel): void {
    this.setPosition(value.position);
    this.setRotation(value.rotation);
    this.speed = value.speed;
  }

  setPosition(value: Vector2) {
    if (this.x == value.x && this.y == value.y) {
      return;
    }
    this.x = value.x;
    this.y = value.y;
    this.positionChangedSubject.next(this.getPosition());
  }

  setRotation(value: number) {
    if (value == this.rotation) {
      return;
    }
    this.rotation = value;
    this.rotationChangedSubject.next(this.rotation);
  }

}
