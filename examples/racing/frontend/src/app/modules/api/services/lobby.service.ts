import {Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import { HttpService } from './http.service';
import { LobbyDTO } from '../interfaces/dto';

@Injectable()
export class LobbyService {

  constructor(
    private readonly apiHttpService: HttpService,
  ) {
  }

  createLobby(playersCount = 1): Observable<LobbyDTO> {
    return this.apiHttpService.apiPost<LobbyDTO>('lobby/createLobby', { playersCount });
  }

  getLobbies(): Observable<LobbyDTO[]> {
    return this.apiHttpService.apiGet<LobbyDTO[]>('lobby/getLobbies');
  }

  quickStart(): Observable<LobbyDTO> {
    return this.apiHttpService.apiPost<LobbyDTO>('lobby/quickStart');
  }
}
