import RoadSplinePointModel from './road-spline-point.model';
import { Line3, Vector3 } from 'three';
import CarPositionOnRoadSplineModel from './car-position-on-road-spline.model';
import CarLapProgressModel from '../../helpers/car-lap-progress.model';

export default class MapRoadSplineModel {

  public roadLength: number;
  public points: RoadSplinePointModel[];
  public lines: Line3[];
  public minSegmentLength: number;

  constructor(spline: Vector3[]) {
    this.minSegmentLength = Number.MAX_SAFE_INTEGER;
    this.roadLength = 0;
    this.points = [];
    this.lines = [];
    if (!spline || spline.length === 0) {
      return;
    }
    for (let i = 0; i < spline.length; i++) {
      if (i > 0) {
        const segmentLength: number = spline[i].distanceTo(spline[i - 1]);
        this.roadLength += segmentLength;
        this.minSegmentLength = Math.min(this.minSegmentLength, segmentLength);
        this.lines.push(new Line3(spline[i - 1], spline[i]));
      }
      this.points.push(new RoadSplinePointModel(spline[i].x, spline[i].y, this.roadLength));
    }
    const lastSegmentLength: number = spline[spline.length - 1].distanceTo(spline[0]);
    this.roadLength += lastSegmentLength;
    this.minSegmentLength = Math.min(this.minSegmentLength, lastSegmentLength);
    this.lines.push(new Line3(spline[spline.length - 1], spline[0]));
  }

  public getNearestPointOnSpline(point: Vector3, searchFromLineIndex: number = -1,
                                 allowance: number = Number.MAX_SAFE_INTEGER): CarPositionOnRoadSplineModel {
    let linesToCheck: { line: Line3, originalIndex: number }[];
    // selecting spline segments to check
    if (searchFromLineIndex === -1) {
      linesToCheck = this.lines.map((line: Line3, originalIndex: number): { line: Line3, originalIndex: number } => {
        return {
          line,
          originalIndex
        };
      });
    } else {
      linesToCheck = [];
      for (let i = searchFromLineIndex - allowance; i <= searchFromLineIndex + allowance; i++) {
        const originalIndex: number = (i + this.lines.length) % this.lines.length;
        linesToCheck.push({
          line: this.lines[originalIndex],
          originalIndex
        });
      }
    }
    // find all nearest points on segments
    const nearestPoints: CarPositionOnRoadSplineModel[] = linesToCheck
      .map((lineDescr: { line: Line3, originalIndex: number }): CarPositionOnRoadSplineModel => {
          return new CarPositionOnRoadSplineModel(
            lineDescr.line ? lineDescr.line.closestPointToPoint(point, true, new Vector3()) : point.clone(),
            lineDescr.originalIndex
          );
        }
      );
    // return point with minimal distance;
    return nearestPoints.reduce((min: CarPositionOnRoadSplineModel, x: CarPositionOnRoadSplineModel) => {
        return x.pointOnSpline.distanceTo(point) < min.pointOnSpline.distanceTo(point) ? x : min;
      },
      new CarPositionOnRoadSplineModel(new Vector3(9999999999, 9999999999, 999999999), 0),
    );
  }

  public getLapProgress(positionOnRoad: CarPositionOnRoadSplineModel): CarLapProgressModel {
    if (this.points.length === 0) {
      return new CarLapProgressModel(0, 0);
    }
    const distanceFromStart: number = this.points[positionOnRoad.lineIndex].distanceFromStart +
      this.lines[positionOnRoad.lineIndex].start.distanceTo(positionOnRoad.pointOnSpline);
    return new CarLapProgressModel(distanceFromStart, 100 * distanceFromStart / this.roadLength);
  }

}
