import { BaseShaderMesh } from './base-shader-mesh';
import {
  BufferGeometry, Camera,
  Color,
  FrontSide,
  Group,
  LinearFilter,
  Material,
  Matrix4,
  PerspectiveCamera,
  Plane,
  RepeatWrapping,
  RGBFormat,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  Texture,
  TextureLoader,
  UniformsLib,
  UniformsUtils,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three';
import { RenderingConsts } from '../../gameplay/consts/rendering.consts';
import ThreeSceneLayerEnum from '../../gameplay/models/enums/three-scene-layer.enum';
import { ResourcesConsts } from '../consts/resources.consts';

export default class SeaShaderMesh extends BaseShaderMesh {

  public clipBias: number = 0;
  private textureMatrix: Matrix4 = new Matrix4();
  private renderTarget: WebGLRenderTarget = new WebGLRenderTarget(
    512,
    512,
    {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      format: RGBFormat,
      stencilBuffer: false,
    });

  private mirrorShader = {
    uniforms: UniformsUtils.merge([
      UniformsLib['fog'],
      UniformsLib['lights'],
      {
        normalSampler: { value: null },
        mirrorSampler: { value: null },
        alpha: { value: 1.0 },
        time: { value: 0.0 },
        size: { value: 1.0 },
        distortionScale: { value: 20.0 },
        textureMatrix: { value: new Matrix4() },
        sunColor: { value: new Color(0xffffff) },
        sunDirection: { value: RenderingConsts.SKY_POSITION },
        eye: { value: new Vector3() },
        waterColor: { value: new Color(0x2690b7) }
      }
    ]),
    vertexShader: [
      'uniform mat4 textureMatrix;',
      'uniform float time;',
      'varying vec4 mirrorCoord;',
      'varying vec4 worldPosition;',
      ShaderChunk.common,
      ShaderChunk['fog_pars_vertex'],
      ShaderChunk['shadowmap_pars_vertex'],
      'void main() {',
      '	mirrorCoord = modelMatrix * vec4( position, 1.0 );',
      '	worldPosition = mirrorCoord.xyzw;',
      '	mirrorCoord = textureMatrix * mirrorCoord;',
      '	vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );',
      '	gl_Position = projectionMatrix * mvPosition;',
      ShaderChunk['fog_vertex'],
      ShaderChunk.beginnormal_vertex,
      ShaderChunk.defaultnormal_vertex,
      ShaderChunk['shadowmap_vertex'],
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D mirrorSampler;',
      'uniform float alpha;',
      'uniform float time;',
      'uniform float size;',
      'uniform float distortionScale;',
      'uniform sampler2D normalSampler;',
      'uniform vec3 sunColor;',
      'uniform vec3 sunDirection;',
      'uniform vec3 eye;',
      'uniform vec3 waterColor;',
      'varying vec4 mirrorCoord;',
      'varying vec4 worldPosition;',
      'vec4 getNoise( vec2 uv ) {',
      '	vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);',
      '	vec2 uv1 = uv / 107.0-vec2( time / -19.0, time / 31.0 );',
      '	vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + vec2( time / 101.0, time / 97.0 );',
      '	vec2 uv3 = uv / vec2( 1091.0, 1027.0 ) - vec2( time / 109.0, time / -113.0 );',
      '	vec4 noise = texture2D( normalSampler, uv0 ) +',
      '		texture2D( normalSampler, uv1 ) +',
      '		texture2D( normalSampler, uv2 ) +',
      '		texture2D( normalSampler, uv3 );',
      '	return noise * 0.5 - 1.0;',
      '}',
      'void sunLight( const vec3 surfaceNormal, const vec3 eyeDirection, float shiny, float spec, float diffuse, inout vec3 diffuseColor, inout vec3 specularColor ) {',
      '	vec3 reflection = normalize( reflect( -sunDirection, surfaceNormal ) );',
      '	float direction = max( 0.0, dot( eyeDirection, reflection ) );',
      '	specularColor += pow( direction, shiny ) * sunColor * spec;',
      '	diffuseColor += max( dot( sunDirection, surfaceNormal ), 0.0 ) * sunColor * diffuse;',
      '}',
      ShaderChunk['common'],
      ShaderChunk['packing'],
      ShaderChunk['bsdfs'],
      ShaderChunk['fog_pars_fragment'],
      ShaderChunk['lights_pars_begin'],
      ShaderChunk['shadowmap_pars_fragment'],
      ShaderChunk['shadowmask_pars_fragment'],
      'void main() {',
      '	vec4 noise = getNoise( worldPosition.xy * size );',
      '	vec3 surfaceNormal = normalize( noise.xyz * vec3( 1.5, 1.0, 1.5 ) );',
      '	vec3 diffuseLight = vec3(0.0);',
      '	vec3 specularLight = vec3(0.0);',
      '	vec3 worldToEye = eye-worldPosition.xyz;',
      '	vec3 eyeDirection = normalize( worldToEye );',
      '	sunLight( surfaceNormal, eyeDirection, 100.0, 2.0, 0.5, diffuseLight, specularLight );',
      '	float distance = length(worldToEye);',
      '	vec2 distortion = surfaceNormal.xy * ( 0.001 + 1.0 / distance ) * distortionScale;',
      '	vec3 reflectionSample = vec3( texture2D( mirrorSampler, mirrorCoord.xy / mirrorCoord.z + distortion ) );',
      '	float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );',
      '	float rf0 = 0.3;',
      '	float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 10.0 );',
      '	vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;',
      '	vec3 albedo = mix( ( sunColor * diffuseLight * 0.3 + scatter ) * getShadowMask(), ( vec3( 0.1 ) + reflectionSample * 0.9 + reflectionSample * specularLight ), reflectance);',
      '	vec3 outgoingLight = albedo;',
      '	gl_FragColor = vec4( outgoingLight, alpha );',
      ShaderChunk['tonemapping_fragment'],
      ShaderChunk['fog_fragment'],
      '}'
    ].join('\n')
  };

  private normalSampler: Texture = new TextureLoader().load(`${ResourcesConsts.RES_PATH}common/shaders/waternormals.jpg`, function (texture) {
    texture.wrapS = texture.wrapT = RepeatWrapping;
  });
  private mirrorCamera: PerspectiveCamera = new PerspectiveCamera();
  private mirrorWorldPosition: Vector3 = new Vector3();
  private cameraWorldPosition: Vector3 = new Vector3();
  private rotationMatrix: Matrix4 = new Matrix4();
  private normal: Vector3 = new Vector3();
  private view: Vector3 = new Vector3();
  private lookAtPosition: Vector3 = new Vector3(0, 0, -1);
  private target: Vector3 = new Vector3();
  private eye: Vector3 = new Vector3();
  private q: Vector4 = new Vector4();
  private mirrorPlane = new Plane();
  private clipPlane: Vector4 = new Vector4();

  constructor(geometry: BufferGeometry) {
    super(geometry);
    this.material = new ShaderMaterial({
      fragmentShader: this.mirrorShader.fragmentShader,
      vertexShader: this.mirrorShader.vertexShader,
      uniforms: UniformsUtils.clone(this.mirrorShader.uniforms),
      transparent: true,
      lights: true,
      side: FrontSide,
      fog: false,
    });
    this.material.uniforms.mirrorSampler.value = this.renderTarget.texture;
    this.material.uniforms.textureMatrix.value = this.textureMatrix;
    this.material.uniforms.alpha.value = 0.8;
    this.material.uniforms.time.value = 0;
    this.material.uniforms.normalSampler.value = this.normalSampler;
    this.material.uniforms.sunColor.value = new Color(0x7F7F7F);
    this.material.uniforms.waterColor.value = new Color(0x002430);
    this.material.uniforms.sunDirection.value = RenderingConsts.SKY_POSITION;
    this.material.uniforms.distortionScale.value = 3.7;
    this.material.uniforms.eye.value = new Vector3(0, 0, 0);
    this.material.uniforms.size.value = 3;
    this.mirrorCamera.layers.set(ThreeSceneLayerEnum.SeaReflectionLayer);
    this.onBeforeRender = (renderer: WebGLRenderer, scene: Scene, camera: Camera, geometry: BufferGeometry,
                            material: Material, group: Group) => {
      this.mirrorWorldPosition.setFromMatrixPosition(this.matrixWorld);
      this.cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
      this.rotationMatrix.extractRotation(this.matrixWorld);
      this.normal.set(0, 0, 1);
      this.normal.applyMatrix4(this.rotationMatrix);
      this.view.subVectors(this.mirrorWorldPosition, this.cameraWorldPosition);
      // Avoid rendering when mirror is facing away
      if (this.view.dot(this.normal) > 0) {
        return;
      }
      this.view.reflect(this.normal)
        .negate();
      this.view.add(this.mirrorWorldPosition);

      this.rotationMatrix.extractRotation(camera.matrixWorld);

      this.lookAtPosition.set(0, 0, -1);
      this.lookAtPosition.applyMatrix4(this.rotationMatrix);
      this.lookAtPosition.add(this.cameraWorldPosition);

      this.target.subVectors(this.mirrorWorldPosition, this.lookAtPosition);
      this.target.reflect(this.normal)
        .negate();
      this.target.add(this.mirrorWorldPosition);

      this.mirrorCamera.position.copy(this.view);
      this.mirrorCamera.up.set(0, 1, 0);
      this.mirrorCamera.up.applyMatrix4(this.rotationMatrix);
      this.mirrorCamera.up.reflect(this.normal);
      this.mirrorCamera.lookAt(this.target);

      if (camera instanceof PerspectiveCamera) {
        this.mirrorCamera.far = camera.far; // Used in WebGLBackground
      }
      this.mirrorCamera.updateMatrixWorld(false);
      this.mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

      // Update the texture matrix
      this.textureMatrix.set(
        0.5, 0.0, 0.0, 0.5,
        0.0, 0.5, 0.0, 0.5,
        0.0, 0.0, 0.5, 0.5,
        0.0, 0.0, 0.0, 1.0
      );
      this.textureMatrix.multiply(this.mirrorCamera.projectionMatrix);
      this.textureMatrix.multiply(this.mirrorCamera.matrixWorldInverse);
      this.mirrorPlane.setFromNormalAndCoplanarPoint(this.normal, this.mirrorWorldPosition);
      this.mirrorPlane.applyMatrix4(this.mirrorCamera.matrixWorldInverse);

      this.clipPlane.set(this.mirrorPlane.normal.x, this.mirrorPlane.normal.y, this.mirrorPlane.normal.z, this.mirrorPlane.constant);
      const projectionMatrix = this.mirrorCamera.projectionMatrix;
      this.q.x = (Math.sign(this.clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
      this.q.y = (Math.sign(this.clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
      this.q.z = -1.0;
      this.q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
      // Calculate the scaled plane vector
      this.clipPlane.multiplyScalar(2.0 / this.clipPlane.dot(this.q));
      // Replacing the third row of the projection matrix
      projectionMatrix.elements[2] = this.clipPlane.x;
      projectionMatrix.elements[6] = this.clipPlane.y;
      projectionMatrix.elements[10] = this.clipPlane.z + 1.0 - this.clipBias;
      projectionMatrix.elements[14] = this.clipPlane.w;
      this.eye.setFromMatrixPosition(camera.matrixWorld);
      const currentRenderTarget = renderer.getRenderTarget();
      const currentVrEnabled = renderer.xr.enabled;
      const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
      this.visible = false;
      renderer.xr.enabled = false; // Avoid camera modification and recursion
      renderer.shadowMap.autoUpdate = false; // Avoid re-computing shadows
      renderer.setRenderTarget(this.renderTarget);
      renderer.clear();
      renderer.render(scene, this.mirrorCamera);
      this.visible = true;
      renderer.xr.enabled = currentVrEnabled;
      renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
      renderer.setRenderTarget(currentRenderTarget);
    };
  }

  public updateShader(raceTime: number) {
    this.material.uniforms.time.value = raceTime / 1000;
  }

}
