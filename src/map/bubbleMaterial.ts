import * as THREE from 'three';

/** Shared by every bubble: depth fade follows the camera. */
export const shared = {
  uFogNear: { value: 300 },
  uFogFar: { value: 1200 },
};

const vertexShader = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

// One shader, two looks: uFill 0 = hollow soap-bubble (bright rim, clear middle),
// uFill 1 = solid pearl (soft shading). Pure greyscale.
const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uFill;
  uniform float uBright;
  uniform float uRim;
  uniform float uSpec;
  uniform float uBase;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(vV);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float rim = pow(1.0 - ndv, 2.6);
    vec3 L = normalize(vec3(-0.45, 0.65, 0.6));
    float diff = clamp(dot(n, L), 0.0, 1.0);
    float spec = pow(clamp(dot(reflect(-L, n), v), 0.0, 1.0), 42.0) * uSpec;

    float hollow = rim * uRim + spec * 0.8 + uBase;
    float shade = (0.38 + 0.62 * diff) * uBright + spec * 0.4 + rim * 0.12;
    vec3 col = mix(vec3(1.0), vec3(shade), uFill);
    float a = mix(hollow, 1.0, uFill);

    float fog = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uOpacity * fog);
  }
`;

export interface BubbleLook {
  fill?: number;
  bright?: number;
  rim?: number;
  spec?: number;
  base?: number;
  additive?: boolean;
}

export function bubbleMaterial({ fill = 0, bright = 1, rim = 1, spec = 1, base = 0.035, additive = false }: BubbleLook) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: fill > 0.5,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uOpacity: { value: 0 },
      uFill: { value: fill },
      uBright: { value: bright },
      uRim: { value: rim },
      uSpec: { value: spec },
      uBase: { value: base },
      ...shared,
    },
  });
}
