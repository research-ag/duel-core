export class CinematicUtils {

  static getDistanceInUniformlyAcceleratedMotion(startVelocity: number, acceleration: number, time: number): number {
    return time * (startVelocity + acceleration * time / 2);
  }

  static getAccelerationInUniformlyAcceleratedMotion(startVelocity: number, distance: number, time: number): number {
    return (2 / Math.pow(time, 2)) * (distance - startVelocity * time);
  }

  static getSpeedInUniformlyAcceleratedMotion(startVelocity: number, acceleration: number, time: number) {
    return startVelocity + acceleration * time;
  }

  static getAccelerationToAchieveSpeed(startVelocity: number, targetVelocity: number, time: number) {
    return (targetVelocity - startVelocity) / time;
  }

}
