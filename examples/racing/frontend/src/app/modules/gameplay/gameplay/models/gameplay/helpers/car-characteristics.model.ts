import { CarData } from '../../../../../api/interfaces/car.interfaces';

export default class CarCharacteristicsModel {

  constructor(
    public readonly steeringFactor: number,
    public readonly dragConstant: number,
    public readonly wheelFrictionConstant: number,
    public readonly engineForce: number,
    public readonly brakingForce: number,
    public readonly mass: number,
  ) {
  }

  // TODO class transformer
  static fromDTO(carDTO: CarData): CarCharacteristicsModel {
    return  new CarCharacteristicsModel(
      carDTO.steering,
      carDTO.dragConstant,
      carDTO.wheelFrictionConstant,
      carDTO.engineForce,
      carDTO.brakingForce,
      carDTO.mass
    );
  }

}
