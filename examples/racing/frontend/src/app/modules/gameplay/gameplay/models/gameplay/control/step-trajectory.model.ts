import { Vector2 } from 'three';
import { PolarPoint } from '../../../../../../../utils/models/polar-point.model';

export default class StepTrajectoryModel {

  public l: number; // step path length (in world units)
  public c: number; // step path trajectory curvature (1 / arc radius in world units)

  constructor(l: number, c: number) {
    this.l = l;
    this.c = c;
  }

  public get arcRadius(): number {
    return 1 / Math.abs(this.c);
  }

  public get arcCenter(): Vector2 {
    return new Vector2(
      0,
      (this.c > 0) ? this.arcRadius : -this.arcRadius
    );
  }

  public get pointerRotation(): number {
    return this.l * this.c;
  }

  public get position(): Vector2 {
    // return this.polarPosition.cartesianPoint; == the same result, but more less memory
    if (this.c === 0) {
      return new Vector2(this.l, 0);
    }
    return new Vector2(
      Math.sin(this.l * this.c) / this.c,
      (1 - Math.cos(this.l * this.c)) / this.c,
    );
  }

  public get polarPosition(): PolarPoint {
    return new PolarPoint(
      (this.c === 0) ? this.l : (2 / this.c) * Math.sin(this.l * this.c / 2),
      (this.l * this.c) / 2
    );
  }

  public static fromCartesianPosition(pos: Vector2): StepTrajectoryModel {
    return StepTrajectoryModel.fromPolarPosition(PolarPoint.fromCartesian(pos));
  }

  public static fromPolarPosition(pos: PolarPoint): StepTrajectoryModel {
    if (pos.theta > Math.PI / 2 || pos.theta < -Math.PI / 2) {
      pos.theta -= Math.PI * Math.sign(pos.theta);
      pos.r = -pos.r;
    }
    return new StepTrajectoryModel(
      pos.theta * pos.r / Math.sin(pos.theta),
      2 * Math.sin(pos.theta) / pos.r
    );
  }

  public clone(): StepTrajectoryModel {
    return new StepTrajectoryModel(this.l, this.c);
  }

  public equals(trajectory: StepTrajectoryModel | null): boolean {
    return !!trajectory && trajectory.l === this.l && trajectory.c === this.c;
  }

  public breakToSegments(segsCount: number = Math.ceil(Math.abs(this.l) * 2)): Vector2[] {
    if (this.l === 0) {
      return [ new Vector2() ];
    }
    const result: Vector2[] = [];
    const step: number = this.l / segsCount;
    // result.push((new StepTrajectoryModel(i * step, this.c).position)); == the same result, but uses more memory
    if (this.c === 0) {
      for (let i: number = 1; i <= segsCount; i++) {
        result.push(new Vector2(i * step, 0));
      }
    } else {
      for (let i: number = 1; i <= segsCount; i++) {
        result.push(new Vector2(
          Math.sin(i * step * this.c) / this.c,
          (1 - Math.cos(i * step * this.c)) / this.c,
        ));
      }
    }
    return result;
  }

}
