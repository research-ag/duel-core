import { Vector2 } from 'three';

export class PolarPoint {

  public r: number;
  public theta: number;

  constructor(r: number, theta: number) {
    this.r = r;
    this.theta = theta;
  }

  public get cartesianPoint(): Vector2 {
    return new Vector2(
      this.r * Math.cos(this.theta),
      this.r * Math.sin(this.theta)
    );
  }

  public static fromCartesian(cartPoint: Vector2, centerPoint?: Vector2): PolarPoint {
    const point: Vector2 = cartPoint.clone();
    if (centerPoint) {
      point.x -= centerPoint.x;
      point.y -= centerPoint.y;
    }
    return new PolarPoint(
      Math.sqrt(Math.pow(point.x, 2) + Math.pow(point.y, 2)),
      Math.atan2(point.y, point.x)
    );
  }

}
