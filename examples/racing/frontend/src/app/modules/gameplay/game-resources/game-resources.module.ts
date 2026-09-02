import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModelLoaderService } from './services/model-loader.service';
import { MapLoaderService } from './services/map-loader.service';
import { CarLoaderService } from './services/car-loader.service';
import { ShaderLoaderService } from './services/shader-loader.service';

@NgModule({
  imports: [
    CommonModule
  ],
  providers: [
    ModelLoaderService,
    MapLoaderService,
    CarLoaderService,
    ShaderLoaderService,
  ]
})
export class GameResourcesModule {
}
