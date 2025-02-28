import type {
  ClickHouseLogLevel,
  ClickHouseSettings,
  Connection,
  ConnectionParams,
  ConnInsertResult,
  ConnQueryResult,
  Logger,
} from '@clickhouse/client-common'
import {
  type DataFormat,
  DefaultLogger,
  LogWriter,
} from '@clickhouse/client-common'
import type { InputJSON, InputJSONObjectEachRow } from './clickhouse_types'
import type { ConnPingResult } from './connection'
import type { BaseResultSet } from './result'

export type MakeConnection<Stream> = (
  params: ConnectionParams
) => Connection<Stream>

export type MakeResultSet<Stream> = (
  stream: Stream,
  format: DataFormat,
  session_id: string
) => BaseResultSet<Stream>

export interface ValuesEncoder<Stream> {
  validateInsertValues<T = unknown>(
    values: InsertValues<Stream, T>,
    format: DataFormat
  ): void

  /**
   * A function encodes an array or a stream of JSON objects to a format compatible with ClickHouse.
   * If values are provided as an array of JSON objects, the function encodes it in place.
   * If values are provided as a stream of JSON objects, the function sets up the encoding of each chunk.
   * If values are provided as a raw non-object stream, the function does nothing.
   *
   * @param values a set of values to send to ClickHouse.
   * @param format a format to encode value to.
   */
  encodeValues<T = unknown>(
    values: InsertValues<Stream, T>,
    format: DataFormat
  ): string | Stream
}

export type CloseStream<Stream> = (stream: Stream) => Promise<void>

export interface ClickHouseClientConfigOptions<Stream> {
  impl: {
    make_connection: MakeConnection<Stream>
    make_result_set: MakeResultSet<Stream>
    values_encoder: ValuesEncoder<Stream>
    close_stream: CloseStream<Stream>
  }
  /** A ClickHouse instance URL. Default value: `http://localhost:8123`. */
  host?: string
  /** The request timeout in milliseconds. Default value: `30_000`. */
  request_timeout?: number
  /** Maximum number of sockets to allow per host. Default value: `Infinity`. */
  max_open_connections?: number

  compression?: {
    /** `response: true` instructs ClickHouse server to respond with
     * compressed response body. Default: true. */
    response?: boolean
    /** `request: true` enabled compression on the client request body.
     * Default: false. */
    request?: boolean
  }
  /** The name of the user on whose behalf requests are made.
   * Default: 'default'. */
  username?: string
  /** The user password. Default: ''. */
  password?: string
  /** The name of the application using the nodejs client.
   * Default: empty. */
  application?: string
  /** Database name to use. Default value: `default`. */
  database?: string
  /** ClickHouse settings to apply to all requests. Default value: {} */
  clickhouse_settings?: ClickHouseSettings
  log?: {
    /** A class to instantiate a custom logger implementation.
     * Default: {@link DefaultLogger} */
    LoggerClass?: new () => Logger
    /** Default: OFF */
    level?: ClickHouseLogLevel
  }
  session_id?: string
}

export type BaseClickHouseClientConfigOptions<Stream> = Omit<
  ClickHouseClientConfigOptions<Stream>,
  'impl'
>

export interface BaseQueryParams {
  /** ClickHouse's settings that can be applied on query level. */
  clickhouse_settings?: ClickHouseSettings
  /** Parameters for query binding. https://clickhouse.com/docs/en/interfaces/http/#cli-queries-with-parameters */
  query_params?: Record<string, unknown>
  /** AbortSignal instance to cancel a request in progress. */
  abort_signal?: AbortSignal
  /** A specific `query_id` that will be sent with this request.
   * If it is not set, a random identifier will be generated automatically by the client. */
  query_id?: string
  session_id?: string
}

export interface QueryParams extends BaseQueryParams {
  /** Statement to execute. */
  query: string
  /** Format of the resulting dataset. */
  format?: DataFormat
}

export interface ExecParams extends BaseQueryParams {
  /** Statement to execute. */
  query: string
}

export type CommandParams = ExecParams
export interface CommandResult {
  query_id: string
}

export type InsertResult = ConnInsertResult
export type ExecResult<Stream> = ConnQueryResult<Stream>
export type PingResult = ConnPingResult

export type InsertValues<Stream, T = unknown> =
  | ReadonlyArray<T>
  | Stream
  | InputJSON<T>
  | InputJSONObjectEachRow<T>

export interface InsertParams<Stream = unknown, T = unknown>
  extends BaseQueryParams {
  /** Name of a table to insert into. */
  table: string
  /** A dataset to insert. */
  values: InsertValues<Stream, T>
  /** Format of the dataset to insert. */
  format?: DataFormat
}

export class ClickHouseClient<Stream = unknown> {
  private readonly connectionParams: ConnectionParams
  private readonly connection: Connection<Stream>
  private readonly makeResultSet: MakeResultSet<Stream>
  private readonly valuesEncoder: ValuesEncoder<Stream>
  private readonly closeStream: CloseStream<Stream>
  private readonly sessionId?: string

  constructor(config: ClickHouseClientConfigOptions<Stream>) {
    this.connectionParams = getConnectionParams(config)
    this.sessionId = config.session_id
    validateConnectionParams(this.connectionParams)
    this.connection = config.impl.make_connection(this.connectionParams)
    this.makeResultSet = config.impl.make_result_set
    this.valuesEncoder = config.impl.values_encoder
    this.closeStream = config.impl.close_stream
  }

  private getQueryParams(params: BaseQueryParams) {
    return {
      clickhouse_settings: {
        ...this.connectionParams.clickhouse_settings,
        ...params.clickhouse_settings,
      },
      query_params: params.query_params,
      abort_signal: params.abort_signal,
      query_id: params.query_id,
      session_id: this.sessionId,
    }
  }

  /**
   * Used for most statements that can have a response, such as SELECT.
   * FORMAT clause should be specified separately via {@link QueryParams.format} (default is JSON)
   * Consider using {@link ClickHouseClient.insert} for data insertion,
   * or {@link ClickHouseClient.command} for DDLs.
   */
  async query(params: QueryParams): Promise<BaseResultSet<Stream>> {
    const format = params.format ?? 'JSON'
    const query = formatQuery(params.query, format)
    const { stream, query_id } = await this.connection.query({
      query,
      ...this.getQueryParams(params),
    })
    return this.makeResultSet(stream, format, query_id)
  }

  /**
   * It should be used for statements that do not have any output,
   * when the format clause is not applicable, or when you are not interested in the response at all.
   * Response stream is destroyed immediately as we do not expect useful information there.
   * Examples of such statements are DDLs or custom inserts.
   * If you are interested in the response data, consider using {@link ClickHouseClient.exec}
   */
  async command(params: CommandParams): Promise<CommandResult> {
    const { stream, query_id } = await this.exec(params)
    await this.closeStream(stream)
    return { query_id }
  }

  /**
   * Similar to {@link ClickHouseClient.command}, but for the cases where the output is expected,
   * but format clause is not applicable. The caller of this method is expected to consume the stream,
   * otherwise, the request will eventually be timed out.
   */
  async exec(params: ExecParams): Promise<ExecResult<Stream>> {
    const query = removeTrailingSemi(params.query.trim())
    return await this.connection.exec({
      query,
      ...this.getQueryParams(params),
    })
  }

  /**
   * The primary method for data insertion. It is recommended to avoid arrays in case of large inserts
   * to reduce application memory consumption and consider streaming for most of such use cases.
   * As the insert operation does not provide any output, the response stream is immediately destroyed.
   * In case of a custom insert operation, such as, for example, INSERT FROM SELECT,
   * consider using {@link ClickHouseClient.command}, passing the entire raw query there (including FORMAT clause).
   */
  async insert<T>(params: InsertParams<Stream, T>): Promise<InsertResult> {
    const format = params.format || 'JSONCompactEachRow'

    this.valuesEncoder.validateInsertValues(params.values, format)
    const query = `INSERT INTO ${params.table.trim()} FORMAT ${format}`

    return await this.connection.insert({
      query,
      values: this.valuesEncoder.encodeValues(params.values, format),
      ...this.getQueryParams(params),
    })
  }

  /**
   * Health-check request. It does not throw if an error occurs -
   * the error is returned inside the result object.
   */
  async ping(): Promise<PingResult> {
    return await this.connection.ping()
  }

  /**
   * Shuts down the underlying connection.
   * This method should ideally be called only once per application lifecycle,
   * for example, during the graceful shutdown phase.
   */
  async close(): Promise<void> {
    return await this.connection.close()
  }
}

function formatQuery(query: string, format: DataFormat): string {
  query = query.trim()
  query = removeTrailingSemi(query)
  return query + ' \nFORMAT ' + format
}

function removeTrailingSemi(query: string) {
  let lastNonSemiIdx = query.length
  for (let i = lastNonSemiIdx; i > 0; i--) {
    if (query[i - 1] !== ';') {
      lastNonSemiIdx = i
      break
    }
  }
  if (lastNonSemiIdx !== query.length) {
    return query.slice(0, lastNonSemiIdx)
  }
  return query
}

function validateConnectionParams({ url }: ConnectionParams): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Only http(s) protocol is supported, but given: [${url.protocol}]`
    )
  }
}

function createUrl(host: string): URL {
  try {
    return new URL(host)
  } catch (err) {
    throw new Error('Configuration parameter "host" contains malformed url.')
  }
}

function getConnectionParams<Stream>(
  config: ClickHouseClientConfigOptions<Stream>
): ConnectionParams {
  return {
    application_id: config.application,
    url: createUrl(config.host ?? 'http://localhost:8123'),
    request_timeout: config.request_timeout ?? 300_000,
    max_open_connections: config.max_open_connections ?? Infinity,
    compression: {
      decompress_response: config.compression?.response ?? true,
      compress_request: config.compression?.request ?? false,
    },
    username: config.username ?? 'default',
    password: config.password ?? '',
    database: config.database ?? 'default',
    clickhouse_settings: config.clickhouse_settings ?? {},
    logWriter: new LogWriter(
      config?.log?.LoggerClass
        ? new config.log.LoggerClass()
        : new DefaultLogger(),
      config.log?.level
    ),
  }
}
