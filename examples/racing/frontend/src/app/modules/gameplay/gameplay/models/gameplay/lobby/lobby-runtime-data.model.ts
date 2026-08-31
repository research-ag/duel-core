import PlayerModel from '../entities/player.model';

export default class LobbyRuntimeDataModel {

  constructor(
    public players: PlayerModel[] = [],
  ) {
  }

}
