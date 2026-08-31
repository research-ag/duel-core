import inside from 'point-in-polygon';
import MathUtils from './math.utils';
import {Vector2, Vector3} from 'three';

export class GeomUtils {

  static getAngleBetweenPoints(point1: Vector2, point2: Vector2): number {
    return Math.atan2(point2.y - point1.y, point2.x - point1.x);
  }

  static getAnglesDifference(angle1: number, angle2: number): number {
    angle1 = GeomUtils.wrapAngle(angle1);
    angle2 = GeomUtils.wrapAngle(angle2);
    let result: number = angle2 - angle1;
    return Math.abs(result) <= Math.PI ? result : -Math.sign(result) * (2 * Math.PI - Math.abs(result));
  }

  static wrapAngle(angle: number): number {
    return MathUtils.wrapRange(angle, -Math.PI, Math.PI);
  }

  static getMiddlePoint(point1: Vector2, point2: Vector2): Vector2 {
    return new Vector2((point1.x + point2.x) / 2, (point1.y + point2.y) / 2);
  }

  static rotatePoint(point: Vector2, angle: number): Vector2 {
    return new Vector2(
      point.x * Math.cos(angle) - point.y * Math.sin(angle),
      point.y * Math.cos(angle) + point.x * Math.sin(angle)
    );
  }

  static isPointInsidePolygon(point: Vector2, polygon: Array<Array<number>>): boolean {
    return inside([point.x, point.y], polygon);
  }

  static discretizePoint(point: Vector3, precision: number = 5): Vector3 {
    return new Vector3(
      Math.round(point.x / precision) * precision,
      Math.round(point.y / precision) * precision,
      Math.round(point.z / precision) * precision,
    );
  }

}
