import { NgModule } from '@angular/core';
import { GameStateService } from './services/game-state.service';

@NgModule({
  imports: [],
  providers: [
    GameStateService,
  ]
})
export class GameSharedModule {
}
