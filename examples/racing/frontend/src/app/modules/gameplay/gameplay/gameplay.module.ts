import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GamePhysicsModule } from '../game-physics/game-physics.module';
import { GameRenderingModule } from '../game-rendering/game-rendering.module';
import { GameResourcesModule } from '../game-resources/game-resources.module';
import { GameCommunicationModule } from '../game-communication/game-communication.module';
import { GameSharedModule } from '../game-shared/game-shared.module';
import { GameViewportModule } from '../game-viewport/game-viewport.module';

@NgModule({
  imports: [
    CommonModule,
    GameSharedModule,
    GameCommunicationModule,
    GamePhysicsModule,
    GameRenderingModule,
    GameResourcesModule,
    GameViewportModule,
  ]
})
export class GameplayModule {
}
