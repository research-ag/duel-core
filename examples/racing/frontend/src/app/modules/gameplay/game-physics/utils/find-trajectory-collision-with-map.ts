import MapDataModel from '../../gameplay/models/gameplay/world/map-data.model';
import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import { Vector2 } from 'three';
import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';
import { GeomUtils } from '../../../../../utils/geom.utils';

export function findTrajectoryCollisionWithMap(map: MapDataModel,
                                               basis: CarPositioningModel,
                                               trajectory: StepTrajectoryModel
): { positioning: CarPositioningModel, pathPassed: number } | null {
  let arcPoints: Vector2[] = trajectory
    .breakToSegments()
    .map((arcLocalPoint: Vector2): Vector2 => {
      arcLocalPoint = GeomUtils.rotatePoint(arcLocalPoint, basis.rotation);
      arcLocalPoint.x += basis.position.x;
      arcLocalPoint.y += basis.position.y;
      return arcLocalPoint;
    });
  for (let i = 0; i < arcPoints.length; i++) {
    const trajectoryPoint: Vector2 = arcPoints[i];
    if (!map.polygon.isContainingPoint(trajectoryPoint)) {
      let collisionPoint: Vector2 = map.polygon.getLinePolygonIntersection(
        i > 0 ? arcPoints[i - 1] : basis.position,
        arcPoints[i]
      );
      // new position is not an intersection point. It is slightly (10 cm) on the track.
      let edgeDistance: number = Math.min(0.1, basis.position.distanceTo(collisionPoint));
      let fixVectorAngle: number = GeomUtils.getAngleBetweenPoints(collisionPoint, basis.position);
      const positioning: CarPositioningModel = new CarPositioningModel();
      let pathPassed: number = 0;
      positioning.speed = 0;
      positioning.rotation = basis.rotation;
      positioning.position = new Vector2(
        collisionPoint.x + Math.cos(fixVectorAngle) * edgeDistance,
        collisionPoint.y + Math.sin(fixVectorAngle) * edgeDistance
      );
      if (basis.position.distanceTo(positioning.position) > 0.01) {
        positioning.rotation += i * (trajectory.pointerRotation / arcPoints.length);
        pathPassed = i / arcPoints.length;
      }
      return {
        positioning,
        pathPassed
      };
    }
  }
  // no collision happened;
  return null;
}
