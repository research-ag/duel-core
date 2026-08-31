export default class CarLapProgressModel {

  public distanceFromStart: number;
  public lapPercent: number;

  constructor(distanceFromStart: number, lapPercent: number) {
    this.distanceFromStart = distanceFromStart;
    this.lapPercent = lapPercent;
  }
}
