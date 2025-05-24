import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 定义常量
const SOPHNET_BASE_URL = "https://www.sophnet.com/api";
const PROJECT_UUID = "Ar79PWUQUAhjJOja2orHs";
const PORT = 3000;
const TOKEN_KEY = "sophnet_anonymous_token";
const MAX_RETRIES = 5; // 增加最大重试次数
const INITIAL_RETRY_DELAY_MS = 100; // 初始重试延迟（毫秒）
const MAX_RETRY_DELAY_MS = 5000; // 最大重试延迟（毫秒）

// 初始化Deno KV
const kv = await Deno.openKv();

// 定义接口
interface AnonymousTokenResponse {
  status: number;
  message: string;
  result: {
    anonymousToken: string;
    expires: string;
  };
  timestamp: number;
}

interface SophNetModel {
  id: number;
  serviceUuid: string | null;
  projectUuid: string;
  displayName: string;
  modelFamily: string;
  available: boolean;
  isBaseModel: boolean;
  features: any;
  supportedStream: boolean;
  supportedImageInputs: boolean;
  schema: Array<{
    name: string;
    displayName: string;
    des: string;
    type: string;
    range: number[];
    defaultValue: number;
    required: boolean;
  }>;
}

interface ModelsResponse {
  status: number;
  message: string;
  result: SophNetModel[];
  timestamp: number;
}

interface TokenInfo {
  token: string;
  expires: string;
}

interface Message {
  role: string;
  content: string;
}

interface Reference {
  content: string;
  id: string;
  index: number;
  title: string;
  type: string;
  url: string;
}

// 随机生成一个用户代理字符串
function getRandomUserAgent(): string {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.2151.44",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/119.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// 计算指数退避延迟
function getExponentialBackoffDelay(retryCount: number): number {
  const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);
  const jitter = Math.random() * INITIAL_RETRY_DELAY_MS; // 添加随机抖动
  return Math.min(delay + jitter, MAX_RETRY_DELAY_MS);
}

// 延迟函数
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 从KV获取token
async function getTokenFromKV(): Promise<TokenInfo | null> {
  const tokenEntry = await kv.get<TokenInfo>([TOKEN_KEY]);
  return tokenEntry.value;
}

// 存储token到KV
async function storeTokenToKV(token: string, expires: string): Promise<void> {
  await kv.set([TOKEN_KEY], { token, expires });
}

// 获取匿名token
async function getAnonymousToken(retryCount = 0): Promise<string> {
  try {
    const response = await fetch(`${SOPHNET_BASE_URL}/sys/login/anonymous`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": getRandomUserAgent(), // 使用随机UA
      },
    });

    // 如果是 429 或 500 错误，进行重试
    if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
      const delay = getExponentialBackoffDelay(retryCount);
      console.warn(`Get token failed with status ${response.status}. Retrying in ${delay}ms... (${retryCount + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return getAnonymousToken(retryCount + 1);
    }

    if (!response.ok) {
      throw new Error(`Failed to get token: ${response.status}`);
    }

    const data = await response.json() as AnonymousTokenResponse;
    await storeTokenToKV(data.result.anonymousToken, data.result.expires);
    return data.result.anonymousToken;
  } catch (error) {
    console.error("Error getting anonymous token:", error);
    throw error;
  }
}

// 获取有效token
async function getValidToken(): Promise<string> {
  // 先尝试从KV获取
  const tokenInfo = await getTokenFromKV();

  // 如果KV中有token且未过期，则使用该token
  if (tokenInfo && new Date(tokenInfo.expires) > new Date()) {
    return tokenInfo.token;
  }

  // 否则获取新token
  return await getAnonymousToken();
}

// 获取模型列表
async function getModels(token: string, retryCount = 0): Promise<SophNetModel[]> {
  try {
    const response = await fetch(
      `${SOPHNET_BASE_URL}/public/playground/models?projectUuid=${PROJECT_UUID}`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": getRandomUserAgent(), // 使用随机UA
          "Authorization": `Bearer anon-${token}`,
        },
      },
    );

    // 如果是401或403错误，尝试刷新token并重试
    if ((response.status === 401 || response.status === 403) && retryCount < MAX_RETRIES) {
      console.log(`Token expired, refreshing and retrying models request (${retryCount + 1}/${MAX_RETRIES})...`);
      const newToken = await getAnonymousToken();
      return await getModels(newToken, retryCount + 1);
    }
    
    // 如果是 429 或 500 错误，进行重试
    if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
        const delay = getExponentialBackoffDelay(retryCount);
        console.warn(`Get models failed with status ${response.status}. Retrying in ${delay}ms... (${retryCount + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return getModels(token, retryCount + 1); // 使用当前token重试，如果失败会在上面的逻辑中刷新
    }

    if (!response.ok) {
      throw new Error(`Failed to get models: ${response.status}`);
    }

    const data = await response.json() as ModelsResponse;

    // 请求成功后获取新token并存储 (后台刷新)
    getAnonymousToken().catch(err => console.error("Background token refresh failed:", err));

    return data.result;
  } catch (error) {
    console.error("Error getting models:", error);
    throw error;
  }
}

// 将SophNet模型转换为OpenAI格式
function transformModelsToOpenAIFormat(models: SophNetModel[]) {
  const transformedModels = [];

  // 为每个模型创建标准版本、搜索版本和全上下文版本
  for (const model of models) {
    // 添加标准模型
    transformedModels.push({
      id: model.modelFamily,
      object: "model",
      created: Date.now(),
      owned_by: "sophnet",
      permission: [{
        id: `modelperm-${model.id}`,
        object: "model_permission",
        created: Date.now(),
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: false,
        allow_search_indices: false,
        allow_view: true,
        allow_fine_tuning: false,
        organization: "*",
        group: null,
        is_blocking: false,
      }],
      root: model.modelFamily,
      parent: null,
    });

    // 添加搜索版本模型
    transformedModels.push({
      id: `${model.modelFamily}-Search`,
      object: "model",
      created: Date.now(),
      owned_by: "sophnet",
      permission: [{
        id: `modelperm-${model.id}-Search`,
        object: "model_permission",
        created: Date.now(),
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: false,
        allow_search_indices: true,
        allow_view: true,
        allow_fine_tuning: false,
        organization: "*",
        group: null,
        is_blocking: false,
      }],
      root: model.modelFamily,
      parent: null,
    });

    // 添加全上下文版本模型
    transformedModels.push({
      id: `${model.modelFamily}-Full-Context`,
      object: "model",
      created: Date.now(),
      owned_by: "sophnet",
      permission: [{
        id: `modelperm-${model.id}-Full-Context`,
        object: "model_permission",
        created: Date.now(),
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: false,
        allow_search_indices: false,
        allow_view: true,
        allow_fine_tuning: false,
        organization: "*",
        group: null,
        is_blocking: false,
      }],
      root: model.modelFamily,
      parent: null,
    });

    // 添加全上下文+搜索版本模型
    transformedModels.push({
      id: `${model.modelFamily}-Full-Context-Search`,
      object: "model",
      created: Date.now(),
      owned_by: "sophnet",
      permission: [{
        id: `modelperm-${model.id}-Full-Context-Search`,
        object: "model_permission",
        created: Date.now(),
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: false,
        allow_search_indices: true,
        allow_view: true,
        allow_fine_tuning: false,
        organization: "*",
        group: null,
        is_blocking: false,
      }],
      root: model.modelFamily,
      parent: null,
    });
  }

  return {
    object: "list",
    data: transformedModels,
  };
}

// 处理全上下文功能
function processFullContext(messages: Message[]): Message[] {
  // 复制消息数组，避免修改原数组
  const messagesCopy = [...messages];

  // 提取系统消息（如果存在）
  const systemMessages = messagesCopy.filter(msg => msg.role === "system");

  // 获取非系统消息
  const nonSystemMessages = messagesCopy.filter(msg => msg.role !== "system");

  // 如果消息总数少于或等于3对（6条消息），则不需要处理
  if (nonSystemMessages.length <= 6) {
    return messages;
  }

  // 提取最后3轮对话（最多6条消息）
  const recentMessages = nonSystemMessages.slice(-6);

  // 提取需要合并的历史消息
  const historyMessages = nonSystemMessages.slice(0, -6);

  // 创建历史消息的摘要
  const historySummary = {
    role: "user",
    content: `这里是此前的对话上下文: ${JSON.stringify(historyMessages)}`
  };

  // 组合新的消息数组：系统消息 + 历史摘要 + 最近消息
  return [...systemMessages, historySummary, ...recentMessages];
}

// 将数字转换为上标形式
function convertToSuperscript(num: number): string {
  const normalDigits = '0123456789';
  const superscriptDigits = '⁰¹²³⁴⁵⁶⁷⁸⁹';

  return num.toString()
    .split('')
    .map(char => {
      const index = normalDigits.indexOf(char);
      return index !== -1 ? superscriptDigits[index] : char;
    })
    .join('');
}

// 处理聊天完成请求
async function handleChatCompletions(
  token: string,
  requestBody: any,
  stream: boolean,
  retryCount = 0,
): Promise<Response> {
  // 检查模型名称的后缀
  const modelId = requestBody.model;
  const webSearchEnable = modelId.includes("-Search");
  const fullContextEnable = modelId.includes("-Full-Context");

  // 根据后缀确定实际模型ID
  let actualModelId = modelId;
  if (webSearchEnable) actualModelId = actualModelId.replace("-Search", "");
  if (fullContextEnable) actualModelId = actualModelId.replace("-Full-Context", "");

  // 处理消息
  let processedMessages = requestBody.messages;
  if (fullContextEnable) {
    processedMessages = processFullContext(requestBody.messages);
  }

  const sophNetBody = {
    temperature: requestBody.temperature || 0.7,
    top_p: requestBody.top_p || 0.9,
    frequency_penalty: requestBody.frequency_penalty || 0,
    presence_penalty: requestBody.presence_penalty || 0,
    max_tokens: requestBody.max_tokens || 2048,
    webSearchEnable: webSearchEnable,
    stop: requestBody.stop || [],
    stream: stream.toString(),
    model_id: actualModelId,
    messages: processedMessages,
  };

  try {
    const response = await fetch(
      `${SOPHNET_BASE_URL}/open-apis/projects/${PROJECT_UUID}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer anon-${token}`,
          "Accept": stream ? "text/event-stream" : "application/json",
          "User-Agent": getRandomUserAgent(), // 使用随机UA
        },
        body: JSON.stringify(sophNetBody),
      },
    );

    // 如果是401或403错误，尝试刷新token并重试
    if ((response.status === 401 || response.status === 403) && retryCount < MAX_RETRIES) {
      console.log(`Chat completion token expired, refreshing and retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      const newToken = await getAnonymousToken();
      // 使用指数退避等待
      const delay = getExponentialBackoffDelay(retryCount);
      await sleep(delay);
      return await handleChatCompletions(newToken, requestBody, stream, retryCount + 1);
    }

    // 如果是 429 或 500 错误，进行指数退避重试
    if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
        const delay = getExponentialBackoffDelay(retryCount);
        console.warn(`Chat completion failed with status ${response.status}. Retrying in ${delay}ms... (${retryCount + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return handleChatCompletions(token, requestBody, stream, retryCount + 1); // 使用当前token重试，如果失败会在上面的逻辑中刷新
    }

    if (!response.ok) {
      throw new Error(`Chat completion failed: ${response.status}`);
    }

    // 请求成功后获取新token并存储 (后台刷新)
    getAnonymousToken().catch(err => console.error("Background token refresh failed:", err));

    return response;

  } catch (error) {
    console.error("Error during chat completion fetch:", error);
    // 如果是网络错误或其他非HTTP错误，也进行指数退避重试
     if (retryCount < MAX_RETRIES) {
        const delay = getExponentialBackoffDelay(retryCount);
        console.warn(`Chat completion network error. Retrying in ${delay}ms... (${retryCount + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        return handleChatCompletions(token, requestBody, stream, retryCount + 1);
     }
    throw error; // 达到最大重试次数后抛出错误
  }
}

// 转换流式响应
async function* transformStreamResponse(
  readableStream: ReadableStream<Uint8Array>,
) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 用于存储所有引用，以便在结束时生成参考资料部分
  const references: Reference[] = [];
  let referencesEmitted = false; // 标记是否已经发送过参考资料部分

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // 如果有引用但尚未发送，在结束前发送参考资料部分
        if (references.length > 0 && !referencesEmitted) {
          const referencesSection = generateReferencesSection(references);
          yield `data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`, // 生成一个唯一的ID
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "sophnet-model", // 可以使用 SophNet 返回的模型名，或者固定一个
            choices: [
              {
                index: 0,
                delta: {
                  content: `\n\n${referencesSection}`,
                },
                finish_reason: null, // 在发送参考资料时，finish_reason通常为null
              },
            ],
          })}\n\n`;
          referencesEmitted = true;
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim() === "" || !line.startsWith("data:")) continue;

        const data = line.substring(5).trim();
        if (data === "[DONE]") {
           // 如果有引用但尚未发送，在结束前发送参考资料部分
          if (references.length > 0 && !referencesEmitted) {
            const referencesSection = generateReferencesSection(references);
            yield `data: ${JSON.stringify({
              id: `chatcmpl-${Date.now()}`, // 生成一个唯一的ID
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "sophnet-model", // 可以使用 SophNet 返回的模型名，或者固定一个
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `\n\n${referencesSection}`,
                  },
                  finish_reason: null, // 在发送参考资料时，finish_reason通常为null
                },
              ],
            })}\n\n`;
            referencesEmitted = true;
          }

          yield "data: [DONE]\n\n";
          continue;
        }

        try {
          const sophNetEvent = JSON.parse(data);

          // 检查是否包含引用
          if (sophNetEvent.choices?.[0]?.refs && sophNetEvent.choices[0].refs.length > 0) {
            // 处理引用
            for (const ref of sophNetEvent.choices[0].refs) {
              // 检查是否已经存在相同URL的引用
              const existingRefIndex = references.findIndex(r => r.url === ref.url);
              if (existingRefIndex === -1) {
                // 添加新引用
                references.push(ref);

                // 生成引用标记，使用上标数字
                const refIndex = references.length;
                const superscriptIndex = `⁽${convertToSuperscript(refIndex)}⁾`;

                // 创建带引用标记的事件
                yield `data: ${JSON.stringify({
                  id: sophNetEvent.id || `chatcmpl-${Date.now()}`, // 使用SophNet ID或生成新ID
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: sophNetEvent.model || "sophnet-model", // 使用SophNet模型名或固定
                  choices: [
                    {
                      index: 0,
                      delta: {
                        // SophNet的引用信息通常不在content中，我们需要手动添加
                        content: `[${superscriptIndex}](${ref.url})`,
                      },
                      finish_reason: null, // 引用事件通常没有finish_reason
                    },
                  ],
                })}\n\n`;
              }
            }
          } else {
            // 转换为OpenAI格式的事件
            const openAIEvent = {
              id: sophNetEvent.id || `chatcmpl-${Date.now()}`, // 使用SophNet ID或生成新ID
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: sophNetEvent.model || "sophnet-model", // 使用SophNet模型名或固定
              choices: [
                {
                  index: 0,
                  delta: {
                    // OpenAI通常将内容放在delta.content
                    reasoning_content: sophNetEvent.choices?.[0]?.delta?.reasoning_content || "",
                    content: sophNetEvent.choices?.[0]?.delta?.content || "",
                  },
                  finish_reason: sophNetEvent.choices?.[0]?.finish_reason || null,
                },
              ],
            };

            yield `data: ${JSON.stringify(openAIEvent)}\n\n`;
          }
        } catch (e) {
          console.error("Error parsing event:", e, "Line:", line);
          // 可以选择在这里发送一个错误事件给客户端
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// 生成参考资料部分
function generateReferencesSection(references: Reference[]): string {
  if (references.length === 0) return "";

  let section = "## 参考资料\n\n";
  references.forEach((ref, index) => {
    section += `${index + 1}. [${ref.title}](${ref.url})\n`;
  });

  return section;
}

// 转换非流式响应
async function transformNonStreamResponse(response: Response) {
  const sophNetResponse = await response.json();

  // 处理引用
  let content = sophNetResponse.choices?.[0]?.message?.content || "";
  const references: Reference[] = [];

  // 收集所有引用
  if (sophNetResponse.choices?.[0]?.message?.refs && sophNetResponse.choices[0].message.refs.length > 0) {
    for (const ref of sophNetResponse.choices[0].message.refs) {
      references.push(ref);
    }

    // 为每个引用添加上标标记
    references.forEach((ref, index) => {
      const refIndex = index + 1;
      const superscriptIndex = `⁽${convertToSuperscript(refIndex)}⁾`;
      // 在内容末尾添加引用标记
      content += ` [${superscriptIndex}](${ref.url})`;
    });

    // 添加参考资料部分
    if (references.length > 0) {
      content += "\n\n" + generateReferencesSection(references);
    }
  }

  return {
    id: sophNetResponse.id || `chatcmpl-${Date.now()}`, // 使用SophNet ID或生成新ID
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: sophNetResponse.model || "sophnet-model", // 使用SophNet模型名或固定
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          reasoning_content: sophNetResponse.choices?.[0]?.message?.reasoning_content || "",
          content: content,
        },
        finish_reason: sophNetResponse.choices?.[0]?.finish_reason || "stop",
      },
    ],
    usage: sophNetResponse.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

// 主处理函数
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS预检请求处理
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 获取有效token
  let token;
  try {
    token = await getValidToken();
  } catch (error) {
    console.error("Failed to get token in handler:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get token", details: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    // 模型列表接口
    if (path === "/v1/models" && req.method === "GET") {
      const models = await getModels(token);
      const openAIModels = transformModelsToOpenAIFormat(models);

      return new Response(JSON.stringify(openAIModels), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 聊天完成接口
    else if (path === "/v1/chat/completions" && req.method === "POST") {
      const requestBody = await req.json();
      const stream = requestBody.stream === true;

      const sophNetResponse = await handleChatCompletions(token, requestBody, stream);

      if (stream) {
        const transformedStream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of transformStreamResponse(sophNetResponse.body!)) {
                controller.enqueue(new TextEncoder().encode(chunk));
              }
              controller.close();
            } catch (error) {
              console.error("Stream transformation error:", error);
              // 在流中发送错误信息
              const errorData = JSON.stringify({
                error: {
                  message: `Stream processing error: ${error.message}`,
                  type: "stream_error",
                  code: null,
                }
              });
              controller.enqueue(new TextEncoder().encode(`data: ${errorData}\n\n`));
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            }
          },
        });

        return new Response(transformedStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        const transformedResponse = await transformNonStreamResponse(sophNetResponse);

        return new Response(JSON.stringify(transformedResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // 未找到路由
    else {
      return new Response(
        JSON.stringify({ error: "Not found", message: "Endpoint not supported" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  } catch (error) {
    console.error("Request handling error:", error);

    // 返回统一的错误响应格式
    return new Response(
      JSON.stringify({
        error: {
          message: error.message,
          type: "api_error", // 或者更具体的错误类型
          code: error.status || null, // 如果是HTTP错误，包含状态码
        }
      }),
      {
        status: error.status || 500, // 使用错误状态码或默认500
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// 启动服务器
console.log(`Starting server on port ${PORT}...`);
serve(handler, { port: PORT });
