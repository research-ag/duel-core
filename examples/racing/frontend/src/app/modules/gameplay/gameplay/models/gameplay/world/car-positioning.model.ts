import { Vector2 } from 'three';

export default class CarPositioningModel {

  public position: Vector2 = new Vector2();
  public rotation: number = 0;
  public speed: number = 0;

  constructor(position: Vector2 = new Vector2(), rotation: number = 0, speed: number = 0) {
    this.position = position;
    this.rotation = rotation;
    // TODO speed is not a "positioning" property. Rethink naming
    this.speed = speed;
  }
}
