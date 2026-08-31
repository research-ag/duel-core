import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import { Intersection, Mesh, PerspectiveCamera, Raycaster, Vector2 } from 'three';
import MathUtils from '../../../../../utils/math.utils';

export function calculateSelectedTrajectory(
  mousePosition: Vector2,
  viewportSize: Vector2,
  camera: PerspectiveCamera,
  controlPlane: Mesh,
  // TODO type
  stepArcProperties: { maxSteeringCurvature: number, minDistance: number, maxDistance: number, momentumDistance: number }
): StepTrajectoryModel | null {
  const rayCaster: Raycaster = new Raycaster();
  rayCaster.setFromCamera(new Vector2(
    (mousePosition.x / viewportSize.x) * 2 - 1,
    -(mousePosition.y / viewportSize.y) * 2 + 1
  ), camera);
  const intersections: Intersection<any>[] = rayCaster.intersectObjects([ controlPlane ]);
  if (intersections.length === 0) {
    return null;
  }
  const trajectory: StepTrajectoryModel = StepTrajectoryModel.fromCartesianPosition(uvToLocalWorld(intersections[0]['uv'] as Vector2));
  trajectory.l = MathUtils.toRange(trajectory.l, stepArcProperties.minDistance, stepArcProperties.maxDistance);
  trajectory.c = MathUtils.toRange(trajectory.c, -stepArcProperties.maxSteeringCurvature, stepArcProperties.maxSteeringCurvature);
  return trajectory;
}

// x going forward, y to the left.
// at car position it's (0.5, 0.5) for uv and (0, 0) in world
function uvToLocalWorld(uvPoint: Vector2): Vector2 {
  return new Vector2(
    (uvPoint.x - 0.5) * 1000,
    (uvPoint.y - 0.5) * 1000
  );
}
