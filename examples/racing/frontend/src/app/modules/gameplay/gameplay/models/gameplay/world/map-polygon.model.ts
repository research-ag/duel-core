import { Vector2, Vector3 } from 'three';
import { GeomUtils } from '../../../../../../../utils/geom.utils';

export default class MapPolygonModel {

  public outerPolygon: number[][] = [
    [ -2048, -2048 ],
    [ 2048, -2048 ],
    [ 2048, 2048 ],
    [ -2048, 2048 ]
  ];
  public innerPolygons: number[][][] = [];

  constructor(outerCurve: Vector3[], innerCurves: Vector3[][]) {
    if (outerCurve) {
      this.outerPolygon = this.parseCurve(outerCurve);
    }
    if (innerCurves) {
      this.innerPolygons = innerCurves.map(curve => this.parseCurve(curve));
    }
  }

  public isContainingPoint(point: Vector2): boolean {
    if (!GeomUtils.isPointInsidePolygon(point, this.outerPolygon)) {
      return false;
    }
    for (let innerPolygon of this.innerPolygons) {
      if (GeomUtils.isPointInsidePolygon(point, innerPolygon)) {
        return false;
      }
    }
    return true;
  }

  // TODO find an elegant way to do it. True hardcore is here
  public getLinePolygonIntersection(point1: Vector2, point2: Vector2): Vector2 {
    let innerPoint: Vector2 = this.isContainingPoint(point1) ? point1 : point2;
    let outerPoint: Vector2 = innerPoint === point1 ? point2 : point1;
    while (innerPoint.distanceTo(outerPoint) > 0.05) {
      let middlePoint: Vector2 = GeomUtils.getMiddlePoint(innerPoint, outerPoint);
      if (this.isContainingPoint(middlePoint)) {
        innerPoint = middlePoint;
      } else {
        outerPoint = middlePoint;
      }
    }
    return GeomUtils.getMiddlePoint(innerPoint, outerPoint);
  }

  private parseCurve(curve: Vector3[]): number[][] {
    return curve.map(point => [ point.x, point.y ]);
  }

}
