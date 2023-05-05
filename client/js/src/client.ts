import {
	process_endpoint,
	RE_SPACE_NAME,
	map_names_to_ids,
	discussions_enabled
} from "./utils.js";

import type {
	EventType,
	EventListener,
	ListenerMap,
	Event,
	Payload,
	PostResponse,
	UploadResponse,
	Status,
	SpaceStatus,
	SpaceStatusCallback
} from "./types.js";

import type { Config } from "./types.js";

type event = <K extends EventType>(
	eventType: K,
	listener: EventListener<K>
) => SubmitReturn;
type predict = (
	endpoint: string | number,
	data?: unknown[],
	event_data?: unknown
) => Promise<unknown>;

type client_return = {
	predict: predict;
	config: Config;
	submit: (
		endpoint: string | number,
		data: unknown[],
		event_data: unknown
	) => SubmitReturn;
	view_api: () => Promise<Record<string, any>>;
};

type SubmitReturn = {
	on: event;
	off: event;
	cancel: () => void;
};

const QUEUE_FULL_MSG = "This application is too busy. Keep trying!";
const BROKEN_CONNECTION_MSG = "Connection errored out.";

export async function post_data(
	url: string,
	body: unknown,
	token?: `hf_${string}`
): Promise<[PostResponse, number]> {
	const headers: {
		Authorization?: string;
		"Content-Type": "application/json";
	} = { "Content-Type": "application/json" };
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		var response = await fetch(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers
		});
	} catch (e) {
		return [{ error: BROKEN_CONNECTION_MSG }, 500];
	}
	const output: PostResponse = await response.json();
	return [output, response.status];
}

export let NodeBlob;

export async function upload_files(
	root: string,
	files: Array<File>,
	token?: `hf_${string}`
): Promise<UploadResponse> {
	const headers: {
		Authorization?: string;
	} = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const formData = new FormData();
	files.forEach((file) => {
		formData.append("files", file);
	});
	try {
		var response = await fetch(`${root}/upload`, {
			method: "POST",
			body: formData,
			headers
		});
	} catch (e) {
		return { error: BROKEN_CONNECTION_MSG };
	}
	const output: UploadResponse["files"] = await response.json();
	return { files: output };
}

export async function duplicate(
	app_reference: string,
	options: {
		hf_token: `hf_${string}`;
		private?: boolean;
		status_callback: SpaceStatusCallback;
	}
) {
	const { hf_token, private: _private } = options;

	const headers = {
		Authorization: `Bearer ${hf_token}`
	};

	const user = (
		await (
			await fetch(`https://huggingface.co/api/whoami-v2`, {
				headers
			})
		).json()
	).name;

	const space_name = app_reference.split("/")[1];
	const body: {
		repository: string;
		private?: boolean;
	} = {
		repository: `${user}/${space_name}`
	};

	if (_private) {
		body.private = true;
	}

	try {
		const response = await fetch(
			`https://huggingface.co/api/spaces/${app_reference}/duplicate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(body)
			}
		);

		if (response.status === 409) {
			return client(`${user}/${space_name}`, options);
		} else {
			const duplicated_space = await response.json();
			return client(duplicated_space.url, options);
		}
	} catch (e: any) {
		throw new Error(e);
	}
}

export async function client(
	app_reference: string,
	options: {
		hf_token?: `hf_${string}`;
		status_callback?: SpaceStatusCallback;
	} = {}
): Promise<client_return> {
	return new Promise(async (res) => {
		const { status_callback, hf_token } = options;
		const return_obj = {
			predict,
			submit,
			view_api
			// duplicate
		};

		if (typeof window === "undefined" || !("WebSocket" in window)) {
			const ws = await import("ws");
			(NodeBlob = (await import("node:buffer")).Blob),
				//@ts-ignore
				(global.WebSocket = ws.WebSocket);
		}

		const { ws_protocol, http_protocol, host, space_id } =
			await process_endpoint(app_reference, hf_token);
		const session_hash = Math.random().toString(36).substring(2);
		const last_status: Record<string, Status["status"]> = {};
		let config: Config;
		let api_map: Record<string, number> = {};

		const listener_map: ListenerMap<EventType> = {};

		let jwt: false | string = false;

		if (hf_token && space_id) {
			jwt = await get_jwt(space_id, hf_token);
		}

		function config_success(_config: Config) {
			config = _config;
			api_map = map_names_to_ids(_config?.dependencies || []);

			return {
				config,
				...return_obj
			};
		}
		let api;
		async function handle_space_sucess(status: SpaceStatus) {
			if (status_callback) status_callback(status);
			if (status.status === "running")
				try {
					config = await resolve_config(`${http_protocol}//${host}`, hf_token);
					api = await view_api();

					res(config_success(config));
				} catch (e) {
					if (status_callback) {
						status_callback({
							status: "error",
							message: "Could not load this space.",
							load_status: "error",
							detail: "NOT_FOUND"
						});
					}
				}
		}

		try {
			config = await resolve_config(`${http_protocol}//${host}`, hf_token);
			api = await view_api();
			res(config_success(config));
		} catch (e) {
			if (space_id) {
				check_space_status(
					space_id,
					RE_SPACE_NAME.test(space_id) ? "space_name" : "subdomain",
					handle_space_sucess
				);
			} else {
				if (status_callback)
					status_callback({
						status: "error",
						message: "Could not load this space.",
						load_status: "error",
						detail: "NOT_FOUND"
					});
			}
		}

		/**
		 * Run a prediction.
		 * @param endpoint - The prediction endpoint to use.
		 * @param status_callback - A function that is called with the current status of the prediction immediately and every time it updates.
		 * @return Returns the data for the prediction or an error message.
		 */
		function predict(endpoint: string, data: unknown[], event_data: unknown) {
			return new Promise((res, rej) => {
				submit(endpoint, data, event_data)
					.on("data", res)
					.on("status", (status) => {
						if (status.status === "error") rej(status);
					});
			});
		}

		function submit(
			endpoint: string | number,
			data: unknown[],
			event_data: unknown
		): SubmitReturn {
			let fn_index: number;
			let api_info;
			if (typeof endpoint === "number") {
				fn_index = endpoint;
				api_info = api.unnamed_endpoints[endpoint];
			} else {
				const trimmed_endpoint = endpoint.replace(/^\//, "");
				fn_index = api_map[trimmed_endpoint];
				api_info = api.named_endpoints[endpoint];
			}

			let websocket: WebSocket;

			const _endpoint = typeof endpoint === "number" ? "/predict" : endpoint;
			let payload: Payload;

			//@ts-ignore
			handle_blob(
				`${http_protocol}//${host + config.path}`,
				data,
				api_info,
				hf_token
			).then((_payload) => {
				payload = { data: _payload, event_data, fn_index };
				if (skip_queue(fn_index, config)) {
					fire_event({
						type: "status",
						endpoint: _endpoint,
						status: "pending",
						queue: false,
						fn_index
					});

					post_data(
						`${http_protocol}//${host + config.path}/run${
							_endpoint.startsWith("/") ? _endpoint : `/${_endpoint}`
						}`,
						{
							...payload,
							session_hash
						},
						hf_token
					)
						.then(([output, status_code]) => {
							if (status_code == 200) {
								fire_event({
									type: "status",
									endpoint: _endpoint,
									fn_index,
									status: "complete",
									eta: output.average_duration,
									queue: false
								});

								fire_event({
									type: "data",
									endpoint: _endpoint,
									fn_index,
									data: output.data
								});
							} else {
								fire_event({
									type: "status",
									status: "error",
									endpoint: _endpoint,
									fn_index,
									message: output.error,
									queue: false
								});
							}
						})
						.catch((e) => {
							fire_event({
								type: "status",
								status: "error",
								message: e.message,
								endpoint: _endpoint,
								fn_index,
								queue: false
							});
						});
				} else {
					fire_event({
						type: "status",
						status: "pending",
						queue: true,
						endpoint: _endpoint,
						fn_index
					});

					let url = new URL(`${ws_protocol}://${host}${config.path}
						/queue/join`);

					if (jwt) {
						url.searchParams.set("__sign", jwt);
					}

					websocket = new WebSocket(url);

					websocket.onclose = (evt) => {
						if (!evt.wasClean) {
							fire_event({
								type: "status",
								status: "error",
								message: BROKEN_CONNECTION_MSG,
								queue: true,
								endpoint: _endpoint,
								fn_index
							});
						}
					};

					websocket.onmessage = function (event) {
						const _data = JSON.parse(event.data);
						const { type, status, data } = handle_message(
							_data,
							last_status[fn_index]
						);

						if (type === "update" && status) {
							// call 'status' listeners
							fire_event({
								type: "status",
								endpoint: _endpoint,
								fn_index,
								...status
							});
							if (status.status === "error") {
								websocket.close();
							}
						} else if (type === "hash") {
							websocket.send(JSON.stringify({ fn_index, session_hash }));
							return;
						} else if (type === "data") {
							websocket.send(JSON.stringify({ ...payload, session_hash }));
						} else if (type === "complete") {
							fire_event({
								type: "status",
								...status,
								status: status?.status!,
								queue: true,
								endpoint: _endpoint,
								fn_index
							});
							websocket.close();
						} else if (type === "generating") {
							fire_event({
								type: "status",
								...status,
								status: status?.status!,
								queue: true,
								endpoint: _endpoint,
								fn_index
							});
						}
						if (data) {
							fire_event({
								type: "data",
								data: data.data,
								endpoint: _endpoint,
								fn_index
							});
						}
					};
				}
			});

			function fire_event<K extends EventType>(event: Event<K>) {
				const narrowed_listener_map: ListenerMap<K> = listener_map;
				let listeners = narrowed_listener_map[event.type] || [];
				listeners?.forEach((l) => l(event));
			}

			function on<K extends EventType>(
				eventType: K,
				listener: EventListener<K>
			) {
				const narrowed_listener_map: ListenerMap<K> = listener_map;
				let listeners = narrowed_listener_map[eventType] || [];
				narrowed_listener_map[eventType] = listeners;
				listeners?.push(listener);

				return { on, off, cancel };
			}

			function off<K extends EventType>(
				eventType: K,
				listener: EventListener<K>
			) {
				const narrowed_listener_map: ListenerMap<K> = listener_map;
				let listeners = narrowed_listener_map[eventType] || [];
				listeners = listeners?.filter((l) => l !== listener);
				narrowed_listener_map[eventType] = listeners;

				return { on, off, cancel };
			}

			async function cancel() {
				fire_event({
					type: "status",
					endpoint: _endpoint,
					fn_index: fn_index,
					status: "complete",
					queue: false
				});

				try {
					await fetch(`${http_protocol}//${host + config.path}/reset`, {
						method: "POST",
						body: JSON.stringify(session_hash)
					});
				} catch (e) {}

				websocket.close();
			}

			return {
				on,
				off,
				cancel
			};
		}

		async function view_api(): Promise<
			ApiInfo<JsApiData> | [{ error: string }, 500]
		> {
			if (api) return api;

			const headers: {
				Authorization?: string;
				"Content-Type": "application/json";
			} = { "Content-Type": "application/json" };
			if (hf_token) {
				headers.Authorization = `Bearer ${hf_token}`;
			}
			try {
				const response = await fetch(`${http_protocol}//${host}/info`, {
					headers
				});

				const api_info = (await response.json()) as ApiInfo<ApiData>;
				if (
					api_info.named_endpoints["/predict"] &&
					!api_info.unnamed_endpoints["0"]
				) {
					api_info.unnamed_endpoints[0] = api_info.named_endpoints["/predict"];
				}

				const x = transform_api_info(api_info);
				return x;
			} catch (e) {
				return [{ error: BROKEN_CONNECTION_MSG }, 500];
			}
		}
	});
}

interface ApiData {
	label: string;
	type: {
		type: any;
		description: string;
	};
	component: string;
	example_input?: any;
}

interface JsApiData {
	label: string;
	type: string;
	component: string;
	example_input: any;
}

interface EndpointInfo<T extends ApiData | JsApiData> {
	parameters: T[];
	returns: T[];
}
interface ApiInfo<T extends ApiData | JsApiData> {
	named_endpoints: {
		[key: string]: EndpointInfo<T>;
	};
	unnamed_endpoints: {
		[key: string]: EndpointInfo<T>;
	};
}

function get_type(type: { [key: string]: any }, component: string) {
	switch (type.type) {
		case "string":
			return "string";
		case "boolean":
			return "boolean";
		case "number":
			return "number";
	}

	if (
		type.description === "any valid value" ||
		type.description === "any valid json"
	) {
		return "any";
	} else if (type.type === "array" && type?.items?.type === "string") {
		return "string[]";
	} else if (component === "Image") {
		return "string";
		// }else if ()
	} else if (type.type?.oneOf) {
		return `Record<{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}> | { name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}`;
	} else if (type?.type?.items?.prefixItems) {
		return "";
	}
}

function get_description(
	type: { type: any; description: string },
	component: string
) {
	if (component === "Gallery") {
	} else if (component === "Gallery") {
		return "Array of files";
	} else if (type?.type?.oneOf) {
		return "Array of files or single file";
	} else {
		return type.description;
	}
}

function transform_api_info(api_info: ApiInfo<ApiData>): ApiInfo<JsApiData> {
	const new_data = {
		named_endpoints: {},
		unnamed_endpoints: {}
	};
	for (const key in api_info) {
		const cat = api_info[key];

		for (const endpoint in cat) {
			const info = cat[endpoint];
			new_data[key][endpoint] = {};
			new_data[key][endpoint].parameters = {};
			new_data[key][endpoint].returns = {};
			new_data[key][endpoint].parameters = info.parameters.map(
				({ label, component, type }) => ({
					label,
					component,
					type: get_type(type, component),
					description: get_description(type, component)
				})
			);

			new_data[key][endpoint].returns = info.parameters.map(
				({ label, component, type }) => ({
					label,
					component,
					type: get_type(type, component),
					description: get_description(type, component)
				})
			);
		}
	}

	return new_data;
}

async function get_jwt(
	space: string,
	token: `hf_${string}`
): Promise<string | false> {
	try {
		const r = await fetch(`https://huggingface.co/api/spaces/${space}/jwt`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		const jwt = (await r.json()).token;

		return jwt || false;
	} catch (e) {
		console.error(e);
		return false;
	}
}

export async function handle_blob(
	endpoint: string,
	data: unknown[],
	api_info,
	token?: `hf_${string}`
): Promise<unknown[]> {
	const blob_refs = await walk_and_store_blobs(
		data,
		undefined,
		[],
		true,
		api_info
	);

	return new Promise((res) => {
		Promise.all(
			blob_refs.map(async ({ path, blob, data, type }) => {
				if (blob) {
					const file_url = (await upload_files(endpoint, [blob], token))
						.files[0];
					return { path, file_url, type };
				} else {
					return { path, base64: data, type };
				}
			})
		)
			.then((r) => {
				r.forEach(({ path, file_url, base64, type }) => {
					if (base64) {
						update_object(data, base64, path);
					} else if (type === "Gallery") {
						update_object(data, file_url, path);
					} else if (file_url) {
						const o = {
							is_file: true,
							name: `${file_url}`,
							data: null
							// orig_name: "file.csv"
						};
						update_object(data, o, path);
					}
				});

				res(data);
			})
			.catch(console.log);
	});
}

function update_object(object, newValue, stack) {
	while (stack.length > 1) {
		object = object[stack.shift()];
	}

	object[stack.shift()] = newValue;
}

export async function walk_and_store_blobs(
	param,
	type = undefined,
	path = [],
	root = false,
	api_info = undefined
) {
	if (Array.isArray(param)) {
		let blob_refs = [];

		await Promise.all(
			param.map(async (v, i) => {
				let new_path = path.slice();
				new_path.push(i);

				const array_refs = await walk_and_store_blobs(
					param[i],
					root ? api_info?.parameters[i]?.component || undefined : type,
					new_path,
					false,
					api_info
				);

				blob_refs = blob_refs.concat(array_refs);
			})
		);

		return blob_refs;
	} else if (globalThis.Buffer && param instanceof globalThis.Buffer) {
		const is_image = type === "Image";
		return [
			{
				path: path,
				blob: is_image ? false : new NodeBlob([param]),
				data: is_image ? `${param.toString("base64")}` : false,
				type
			}
		];
	} else if (param instanceof Blob) {
		if (type === "Image") {
			let data;

			if (typeof window !== "undefined") {
				// browser
				data = await image_to_data_uri(param);
			} else {
				const buffer = await param.arrayBuffer();
				data = Buffer.from(buffer).toString("base64");
			}

			return [{ path, data, type }];
		} else {
			return [{ path: path, blob: param, type }];
		}
	} else if (typeof param === "object") {
		let blob_refs = [];
		for (let key in param) {
			if (param.hasOwnProperty(key)) {
				let new_path = path.slice();
				new_path.push(key);
				blob_refs = blob_refs.concat(
					await walk_and_store_blobs(
						param[key],
						undefined,
						new_path,
						false,
						api_info
					)
				);
			}
		}
		return blob_refs;
	} else {
		return [];
	}
}

function image_to_data_uri(blob: Blob) {
	return new Promise((resolve, _) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result);
		reader.readAsDataURL(blob);
	});
}

function skip_queue(id: number, config: Config) {
	return (
		!(config?.dependencies?.[id]?.queue === null
			? config.enable_queue
			: config?.dependencies?.[id]?.queue) || false
	);
}

async function resolve_config(
	endpoint?: string,
	token?: `hf_${string}`
): Promise<Config> {
	const headers: { Authorization?: string } = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (
		typeof window !== "undefined" &&
		window.gradio_config &&
		location.origin !== "http://localhost:9876"
	) {
		const path = window.gradio_config.root;
		const config = window.gradio_config;
		config.root = endpoint + config.root;
		return { ...config, path: path };
	} else if (endpoint) {
		let response = await fetch(`${endpoint}/config`, { headers });

		if (response.status === 200) {
			const config = await response.json();
			config.path = config.path ?? "";
			config.root = endpoint;
			return config;
		} else {
			throw new Error("Could not get config.");
		}
	}

	throw new Error("No config or app endpoint found");
}

async function check_space_status(
	id: string,
	type: "subdomain" | "space_name",
	status_callback: SpaceStatusCallback
) {
	let endpoint =
		type === "subdomain"
			? `https://huggingface.co/api/spaces/by-subdomain/${id}`
			: `https://huggingface.co/api/spaces/${id}`;
	let response;
	let _status;
	try {
		response = await fetch(endpoint);
		_status = response.status;
		if (_status !== 200) {
			throw new Error();
		}
		response = await response.json();
	} catch (e) {
		status_callback({
			status: "error",
			load_status: "error",
			message: "Could not get space status",
			detail: "NOT_FOUND"
		});
		return;
	}

	if (!response || _status !== 200) return;
	const {
		runtime: { stage },
		id: space_name
	} = response;

	switch (stage) {
		case "STOPPED":
		case "SLEEPING":
			status_callback({
				status: "sleeping",
				load_status: "pending",
				message: "Space is asleep. Waking it up...",
				detail: stage
			});

			setTimeout(() => {
				check_space_status(id, type, status_callback);
			}, 1000);
			break;
		// poll for status
		case "RUNNING":
		case "RUNNING_BUILDING":
			status_callback({
				status: "running",
				load_status: "complete",
				message: "",
				detail: stage
			});
			// load_config(source);
			//  launch
			break;
		case "BUILDING":
			status_callback({
				status: "building",
				load_status: "pending",
				message: "Space is building...",
				detail: stage
			});

			setTimeout(() => {
				check_space_status(id, type, status_callback);
			}, 1000);
			break;
		default:
			status_callback({
				status: "space_error",
				load_status: "error",
				message: "This space is experiencing an issue.",
				detail: stage,
				discussions_enabled: await discussions_enabled(space_name)
			});
			break;
	}
}

function handle_message(
	data: any,
	last_status: Status["status"]
): {
	type: "hash" | "data" | "update" | "complete" | "generating" | "none";
	data?: any;
	status?: Status;
} {
	const queue = true;
	switch (data.msg) {
		case "send_data":
			return { type: "data" };
		case "send_hash":
			return { type: "hash" };
		case "queue_full":
			return {
				type: "update",
				status: {
					queue,
					message: QUEUE_FULL_MSG,
					status: "error"
				}
			};
		case "estimation":
			return {
				type: "update",
				status: {
					queue,
					status: last_status || "pending",
					size: data.queue_size,
					position: data.rank,
					eta: data.rank_eta
				}
			};
		case "progress":
			return {
				type: "update",
				status: {
					queue,
					status: "pending",
					progress: data.progress_data
				}
			};
		case "process_generating":
			return {
				type: "generating",
				status: {
					queue,
					message: !data.success ? data.output.error : null,
					status: data.success ? "generating" : "error",
					progress: data.progress_data,
					eta: data.average_duration
				},
				data: data.success ? data.output : null
			};
		case "process_completed":
			return {
				type: "complete",
				status: {
					queue,
					message: !data.success ? data.output.error : undefined,
					status: data.success ? "complete" : "error",
					progress: data.progress_data,
					eta: data.output.average_duration
				},
				data: data.success ? data.output : null
			};
		case "process_starts":
			return {
				type: "update",
				status: {
					queue,
					status: "pending",
					size: data.rank,
					position: 0
				}
			};
	}

	return { type: "none", status: { status: "error", queue } };
}
