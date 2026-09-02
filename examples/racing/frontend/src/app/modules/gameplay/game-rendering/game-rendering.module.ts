import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RenderingService } from './services/rendering.service';
import { ControlSceneService } from './services/scenes/control-scene.service';
import { WorldSceneService } from './services/scenes/world-scene.service';

@NgModule({
  imports: [
    CommonModule,
  ],
  declarations: [],
  providers: [
    RenderingService,
    WorldSceneService,
    ControlSceneService,
  ]
})
export class GameRenderingModule {
}
