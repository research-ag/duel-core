import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import MapDataModel from '../../gameplay/models/gameplay/world/map-data.model';
import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';
import { Vector2 } from 'three';
import { findTrajectoryCollisionWithMap } from '../utils/find-trajectory-collision-with-map';
import { Move } from '../../gameplay/models/gameplay/control/move.type';
import Car from '../../gameplay/models/gameplay/entities/car.model';
import { VehiclePhysicsService } from './vehicle-physics.service';
import { CinematicUtils } from '../../../../../utils/cinematic.utils';
import { PolarPoint } from '../../../../../utils/models/polar-point.model';

export class GamePhysicsService {

  constructor(
    private readonly vehiclePhysicsService: VehiclePhysicsService,
  ) {
  }

  /**
   * simulate all movable objects for next step, returns functions, which are calculating positioning depending on time offset;
   * */
  public simulateMove(
    map: MapDataModel,
    cars: { positioning: CarPositioningModel, move: Move }[]
  ): ((timeOffset: number) => CarPositioningModel)[] {
    return cars
      .map((descriptor): ((timeOffset: number) => CarPositioningModel) => {
        return this.simulateCarSimpleMove(map, descriptor.positioning, descriptor.move);
      });
  }

  public getNextStepArea(car: Car): { maxSteeringCurvature: number, minDistance: number, maxDistance: number } {
    let minDistance: number;
    let maxDistance: number;
    let maxSteeringCurvature: number;
    minDistance = Math.max(
      0,
      CinematicUtils.getDistanceInUniformlyAcceleratedMotion(
        car.speed,
        -this.vehiclePhysicsService.getMaxDeceleration(car.characteristics, car.speed),
        1
      )
    );
    maxDistance = CinematicUtils.getDistanceInUniformlyAcceleratedMotion(
      car.speed,
      this.vehiclePhysicsService.getMaxAcceleration(car.characteristics, car.speed),
      1
    );
    maxSteeringCurvature = this.vehiclePhysicsService.getSteeringMaxCurvature(car.characteristics, car.speed);
    // back draft
    if (Math.abs(car.speed) < 0.25) {
      minDistance = -maxDistance + Math.abs(car.speed);
    }
    return {
      maxSteeringCurvature,
      minDistance,
      maxDistance
    };
  }

  private simulateCarSimpleMove(map: MapDataModel, startPositioning: CarPositioningModel,
                                move: Move): ((timeOffset: number) => CarPositioningModel) {
    if (!move.trajectory) {
      return () => startPositioning;
    }
    const trajectory = move.trajectory as StepTrajectoryModel;
    const collision = findTrajectoryCollisionWithMap(map, startPositioning, trajectory);
    return (timeOffset: number): CarPositioningModel => {
      const pastTrajectory: StepTrajectoryModel = new StepTrajectoryModel(
        CinematicUtils.getDistanceInUniformlyAcceleratedMotion(startPositioning.speed, move.acceleration, timeOffset),
        trajectory.c
      );
      if (collision && Math.abs(pastTrajectory.l) >= Math.abs(collision.pathPassed * trajectory.l)) {
        return collision.positioning;
      } else {
        const newPositionPolarPoint: PolarPoint = pastTrajectory.polarPosition;
        newPositionPolarPoint.theta += startPositioning.rotation;
        const newPosition: Vector2 = newPositionPolarPoint.cartesianPoint;
        newPosition.x += startPositioning.position.x;
        newPosition.y += startPositioning.position.y;
        return new CarPositioningModel(
          newPosition,
          startPositioning.rotation + pastTrajectory.pointerRotation,
          trajectory.l < 0 ?
            0 :
            CinematicUtils.getSpeedInUniformlyAcceleratedMotion(startPositioning.speed, move.acceleration, timeOffset)
        );
      }
    };
  }

}
