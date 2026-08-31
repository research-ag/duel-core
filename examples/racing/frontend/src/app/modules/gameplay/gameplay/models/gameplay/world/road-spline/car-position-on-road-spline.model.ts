import { Vector3 } from 'three';

export default class CarPositionOnRoadSplineModel {

  public pointOnSpline: Vector3;
  public lineIndex: number;

  constructor(pointOnSpline: Vector3, lineIndex: number) {
    this.pointOnSpline = pointOnSpline;
    this.lineIndex = lineIndex;
  }
}
