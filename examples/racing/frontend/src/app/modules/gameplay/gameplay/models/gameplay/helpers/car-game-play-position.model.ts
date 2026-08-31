import CarLapProgressModel from './car-lap-progress.model';

export default class CarGamePlayPositionModel {

  slot: number;
  progress: CarLapProgressModel;
  lapNumber: number;

  constructor(slot: number, progress: CarLapProgressModel, lapNumber: number) {
    this.slot = slot;
    this.progress = progress;
    this.lapNumber = lapNumber;
  }

}
