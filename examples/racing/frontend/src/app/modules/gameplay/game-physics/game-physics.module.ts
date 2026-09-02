import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GamePhysicsService } from './services/game-physics.service';
import { VehiclePhysicsService } from './services/vehicle-physics.service';

@NgModule({
  imports: [
    CommonModule
  ],
  providers: [
    GamePhysicsService,
    VehiclePhysicsService,
  ],
  declarations: []
})
export class GamePhysicsModule {
}
