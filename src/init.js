/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as THREE from 'three';

import { XRDevice, metaQuest3 } from 'iwer';

import { DevUI } from '@iwer/devui';
import { GamepadWrapper } from 'gamepad-wrapper';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export async function init(setupScene = () => {}, onFrame = () => {}) {
	// iwer setup
	let nativeWebXRSupport = false;
	if (navigator.xr) {
		nativeWebXRSupport = await navigator.xr.isSessionSupported('immersive-vr');
	}
	if (!nativeWebXRSupport) {
		const xrDevice = new XRDevice(metaQuest3);
		xrDevice.installRuntime();
		xrDevice.fovy = (75 / 180) * Math.PI;
		xrDevice.ipd = 0;
		window.xrdevice = xrDevice;
		xrDevice.controllers.right.position.set(0.15649, 1.43474, -0.38368);
		xrDevice.controllers.right.quaternion.set(
			0.14766305685043335,
			0.02471366710960865,
			-0.0037767395842820406,
			0.9887216687202454,
		);
		xrDevice.controllers.left.position.set(-0.15649, 1.43474, -0.38368);
		xrDevice.controllers.left.quaternion.set(
			0.14766305685043335,
			0.02471366710960865,
			-0.0037767395842820406,
			0.9887216687202454,
		);
		new DevUI(xrDevice);
	}

	const container = document.createElement('div');
	document.body.appendChild(container);

	const scene = new THREE.Scene();
	scene.background = null;

	const camera = new THREE.PerspectiveCamera(
		50,
		window.innerWidth / window.innerHeight,
		0.1,
		100,
	);
	camera.position.set(0, 1.6, 3);

	const controls = new OrbitControls(camera, container);
	controls.target.set(0, 1.6, 0);
	controls.update();

	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setClearColor(0x000000, 0);
	renderer.xr.enabled = true;
	renderer.xr.setReferenceSpaceType('local-floor');
	container.appendChild(renderer.domElement);

	const environment = new RoomEnvironment(renderer);
	const pmremGenerator = new THREE.PMREMGenerator(renderer);
	scene.environment = pmremGenerator.fromScene(environment).texture;

	const player = new THREE.Group();
	scene.add(player);
	player.add(camera);

	const controllerModelFactory = new XRControllerModelFactory();
	const controllers = {
		left: null,
		right: null,
	};
	for (let i = 0; i < 2; i++) {
		const raySpace = renderer.xr.getController(i);
		const gripSpace = renderer.xr.getControllerGrip(i);
		const mesh = controllerModelFactory.createControllerModel(gripSpace);
		gripSpace.add(mesh);
		// F3: a visible ray pointer for each controller. The line is a unit segment along
		// -Z that Lesson.updatePointers rescales to the hit distance every frame, so the
		// student sees exactly where the trigger will land instead of guessing. Both
		// children are made unpickable so they can never intercept an aim ray.
		const rayLine = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
			new THREE.LineBasicMaterial({ color: 0x9fc2e0, transparent: true, opacity: 0.55 }),
		);
		rayLine.raycast = () => {};
		rayLine.scale.z = 3;
		const cursor = new THREE.Mesh(
			new THREE.SphereGeometry(0.008, 12, 10),
			new THREE.MeshBasicMaterial({ color: 0x9fc2e0 }),
		);
		cursor.raycast = () => {};
		cursor.position.z = -3;
		raySpace.add(rayLine, cursor);
		player.add(raySpace, gripSpace);
		raySpace.visible = false;
		gripSpace.visible = false;
		gripSpace.addEventListener('connected', (e) => {
			raySpace.visible = true;
			gripSpace.visible = true;
			const handedness = e.data.handedness;
			controllers[handedness] = {
				raySpace,
				gripSpace,
				mesh,
				gamepad: new GamepadWrapper(e.data.gamepad),
				rayLine,
				cursor,
			};
		});
		gripSpace.addEventListener('disconnected', (e) => {
			raySpace.visible = false;
			gripSpace.visible = false;
			const handedness = e.data.handedness;
			controllers[handedness] = null;
		});
	}

	function onWindowResize() {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();

		renderer.setSize(window.innerWidth, window.innerHeight);
	}

	window.addEventListener('resize', onWindowResize);

	const globals = {
		scene,
		camera,
		renderer,
		player,
		controllers,
		controls,
	};

	const sky = await loadSky(scene);
	globals.sky = sky;
	setupScene(globals);

	const clock = new THREE.Clock();
	function animate() {
		const delta = clock.getDelta();
		const time = clock.getElapsedTime();
		Object.values(controllers).forEach((controller) => {
			if (controller?.gamepad) {
				controller.gamepad.update();
			}
		});
		onFrame(delta, time, globals);
		renderer.render(scene, camera);
	}

	renderer.setAnimationLoop(animate);

	document.body.appendChild(makeXRButton(renderer));
}

/** Equirect 360 as a sky sphere so hiding it reveals Quest passthrough in immersive-ar. */
async function loadSky(scene) {
	try {
		const tex = await new THREE.TextureLoader().loadAsync('assets/env/ymax-360.png');
		tex.mapping = THREE.EquirectangularReflectionMapping;
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 4;
		const sky = new THREE.Mesh(
			new THREE.SphereGeometry(40, 48, 24),
			new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false }),
		);
		sky.name = 'envSky';
		sky.renderOrder = -1;
		sky.raycast = () => {};
		scene.add(sky);
		return sky;
	} catch (err) {
		console.warn('360 environment failed to load', err);
		return null;
	}
}

/**
 * ENTER XR: prefer immersive-ar on Quest so passthrough is available; fall back to VR.
 * https://threejs.org/docs/WebXRManager.html
 */
function makeXRButton(renderer) {
	const btn = document.createElement('button');
	Object.assign(btn.style, {
		position: 'absolute',
		left: 'calc(50% - 75px)',
		bottom: '20px',
		width: '150px',
		padding: '12px',
		border: '1px solid #fff',
		borderRadius: '4px',
		background: 'rgba(0,0,0,0.5)',
		color: '#fff',
		font: 'bold 13px sans-serif',
		cursor: 'pointer',
		zIndex: '999',
	});
	btn.textContent = 'ENTER VR';
	const sync = () => {
		btn.textContent = renderer.xr.isPresenting ? 'EXIT XR' : 'ENTER VR';
	};
	btn.addEventListener('click', async () => {
		if (renderer.xr.getSession()) {
			renderer.xr.getSession().end();
			return;
		}
		if (!navigator.xr) return;
		let mode = 'immersive-vr';
		try {
			if (await navigator.xr.isSessionSupported('immersive-ar')) mode = 'immersive-ar';
		} catch {
			/* desktop / emulator */
		}
		const session = await navigator.xr.requestSession(mode, {
			optionalFeatures: ['local-floor', 'bounded-floor'],
		});
		await renderer.xr.setSession(session);
	});
	renderer.xr.addEventListener('sessionstart', sync);
	renderer.xr.addEventListener('sessionend', sync);
	return btn;
}
