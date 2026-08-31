import { Mesh, ShaderMaterial } from 'three';

export class BaseShaderMesh extends Mesh {

  public material: ShaderMaterial = new ShaderMaterial();

  public updateShader(raceTime: number) {

  }

}
