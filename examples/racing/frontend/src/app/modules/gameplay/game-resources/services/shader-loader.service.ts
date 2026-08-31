import { Mesh, Object3D } from 'three';
import { BaseShaderMesh } from '../shaders/base-shader-mesh';
import SeaShaderMesh from '../shaders/sea.shader-mesh';

export class ShaderLoaderService {

  private shaderMap: Map<string, typeof BaseShaderMesh> = new Map<string, typeof BaseShaderMesh>();

  constructor() {
    this.shaderMap.set('sea', SeaShaderMesh);
  }

  public attachShader(node: Mesh, shaderName: string): Object3D {
    const klass = this.shaderMap.get(shaderName);
    if (!klass) {
      console.warn(`Could not find shader for alias "${shaderName}"`);
      return node;
    }
    const newNode: BaseShaderMesh = new klass(node.geometry);
    newNode.position.copy(node.position);
    newNode.rotation.copy(node.rotation);
    newNode.scale.copy(node.scale);
    return newNode;
  }

}
