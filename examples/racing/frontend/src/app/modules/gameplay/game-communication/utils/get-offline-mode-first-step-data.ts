import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';

export default function getOfflineModeFirstStepData(positions: CarPositioningModel[]) {
  return [ {
    'slot': 0,
    'step': {
      'finalCarProperties': positions[0] || new CarPositioningModel(),
      'trajectory': null,
      'acceleration': 0
    }
  }
  ];
}
