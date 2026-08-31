import CarCharacteristicsModel from '../../gameplay/models/gameplay/helpers/car-characteristics.model';
import { CinematicUtils } from '../../../../../utils/cinematic.utils';

export class VehiclePhysicsService {

  // TODO this must be one more car characteristic, u-turn radius on minimal speed. Set to 5.5 meters for now
  private static DORMANT_TURN_RADIUS: number = 5.5;

  // TODO must be more complicated formula in future, this is strongly simplified
  public getEngineForce(characteristics: CarCharacteristicsModel): number {
    return characteristics.engineForce;
  }

  // TODO must be more complicated formula in future, this is strongly simplified
  public getBrakingForce(characteristics: CarCharacteristicsModel): number {
    return characteristics.brakingForce;
  }

  // TODO must be more complicated formula in future, this is strongly simplified
  public getSteeringMaxCurvature(characteristics: CarCharacteristicsModel, velocity: number): number {
    return 1 / (VehiclePhysicsService.DORMANT_TURN_RADIUS + Math.pow(velocity, 2) / characteristics.steeringFactor);
  }

  // TODO must be in common physics for all objects
  public getDragForce(characteristics: CarCharacteristicsModel, velocity: number): number {
    return characteristics.dragConstant * Math.pow(velocity, 2);
  }

  public getWheelFrictionForce(characteristics: CarCharacteristicsModel, velocity: number): number {
    return characteristics.wheelFrictionConstant * Math.abs(velocity);
  }

  public getMaxAcceleration(characteristics: CarCharacteristicsModel, velocity: number): number {
    return (this.getEngineForce(characteristics) - this.getDragForce(characteristics, velocity) - this.getWheelFrictionForce(characteristics, velocity)) / characteristics.mass;
  }

  public getMaxDeceleration(characteristics: CarCharacteristicsModel, velocity: number): number {
    // AG: not allowing to go backwards in one move. Maximum deceleration == deceleration to full stop
    const decelerationToFullStopInOneSecond: number = -CinematicUtils.getAccelerationToAchieveSpeed(velocity, 0, 1);
    return Math.min(
      decelerationToFullStopInOneSecond,
      (this.getBrakingForce(characteristics) + this.getDragForce(characteristics, velocity) + this.getWheelFrictionForce(characteristics, velocity)) / characteristics.mass
    );
  }


}
