import { CarData } from '../../../../../api/interfaces/car.interfaces';

export default class PlayerModel {

  constructor(
    public slot: number,
    public car: CarData | null = null,
  ) {
  }
}
