import { NgModule } from '@angular/core';
import { ViewportService } from './services/viewport.service';
import { GameStageComponent } from './components/game-stage/game-stage.component';
import { DisplayService } from './services/display.service';
import { ThreeRenderingService } from './services/three-rendering.service';

@NgModule({
  imports: [],
  providers: [
    ViewportService,
    DisplayService,
    ThreeRenderingService,
  ],
  exports: [
    GameStageComponent
  ],
  declarations: [
    GameStageComponent
  ]
})
export class GameViewportModule {
}
