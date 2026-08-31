import { Scene } from 'three';
import { ModelLoaderService } from './model-loader.service';
import { ShadowStrategy } from '../../game-rendering/enums/shadow-strategy.enum';
import { ResourcesConsts } from '../consts/resources.consts';

export class CarLoaderService {

  private CARS_CACHE: Map<string, Scene> = new Map<string, Scene>();

  constructor(
    private readonly modelLoaderService: ModelLoaderService
  ) {
  }

  async loadCar(carName: string): Promise<any> {
    const cached: any = this.CARS_CACHE.get(carName);
    if (cached) {
      console.log('Car loaded from cache');
      return cached.clone();
    }
    // TODO: get url from car item
    const [ scene, meta ] = await this.modelLoaderService.loadScene(
      `${ResourcesConsts.RES_PATH}cars/${carName}/`, 'body', ShadowStrategy.FORCE_SHADOW, ShadowStrategy.FORCE_SHADOW
    );
    this.CARS_CACHE.set(carName, scene);
    return scene;
  }

}
