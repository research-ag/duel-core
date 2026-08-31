import { Vector3 } from 'three';

export default class RoadSplinePointModel extends Vector3 {

  public distanceFromStart: number;

  constructor(x: number, y: number, distanceFromStart: number) {
    super(x, y, 0);
    this.distanceFromStart = distanceFromStart;
  }

}
