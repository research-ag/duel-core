import { UserData } from '../../../api/interfaces/user.interfaces';
import { GameState } from '../../../api/enums/game-state.enum';

export default function getOfflineModeLobbyRuntimeData(me: UserData) {
  return {
    'lobbyId': 66,
    'settings': {
      'map': 'default',
      'slotsCount': 1,
      'moveTimeout': 7000
    },
    'players': [ {
      'connectionId': 'whatever',
      'userModel': me,
      'isLobbyOwner': true,
      'car': {
        'name': 'Lexus RX 350',
        'model': 'lambo_aventador',
        'steering': 20,
        'dragConstant': 0.4257,
        'wheelFrictionConstant': 12.8,
        'engineForce': 19440,
        'brakingForce': 26000,
        'mass': 1350
      },
      'slot': 0,
      'isLoading': false,
      'isReadyToStart': true,
      'currentStep': null
    }
    ],
    'state': GameState.LobbyFull
  };
}
