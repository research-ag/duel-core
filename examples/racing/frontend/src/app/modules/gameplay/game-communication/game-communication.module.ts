import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SocketService } from './services/socket.service';
import { LobbyConnectionService } from './services/lobby-connection.service';

@NgModule({
  imports: [
    CommonModule
  ],
  providers: [
    SocketService,
    LobbyConnectionService,
  ]
})
export class GameCommunicationModule {
}
