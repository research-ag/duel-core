import { Vector3 } from 'three';

export class RenderingConsts {
  public static FIELD_OF_VIEW = 45;
  public static CAMERA_NEAR_CLIPPING_PANE: number = 1;
  public static CAMERA_FAR_CLIPPING_PANE: number = 10000;
  // TODO that's must be in map metadata
  public static sunLightPhi: number = 0.9;
  public static sunLightTheta: number = 2.5;

  public static get SKY_POSITION(): Vector3 {
    return new Vector3(
      Math.cos(this.sunLightTheta) * Math.sin(this.sunLightPhi),
      Math.sin(this.sunLightTheta) * Math.sin(this.sunLightPhi),
      Math.cos(this.sunLightPhi)
    );
  }
}
