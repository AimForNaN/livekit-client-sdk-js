import { EventEmitter } from 'events';
import type { MediaAttributes } from 'sdp-transform';
import type TypedEventEmitter from 'typed-emitter';
import type { SignalOptions } from '../api/SignalClient';
import {
  SignalClient,
  SignalConnectionState,
  toProtoSessionDescription,
} from '../api/SignalClient';
import log from '../logger';
import type { InternalRoomOptions } from '../options';
import {
  ClientConfigSetting,
  ClientConfiguration,
  DataPacket,
  DataPacket_Kind,
  DisconnectReason,
  ParticipantInfo,
  ReconnectReason,
  Room as RoomModel,
  SpeakerInfo,
  TrackInfo,
  UserPacket,
} from '../proto/livekit_models_pb';
import {
  type AddTrackRequest,
  type ConnectionQualityUpdate,
  DataChannelInfo,
  type JoinResponse,
  type LeaveRequest,
  type ReconnectResponse,
  SignalTarget,
  type StreamStateUpdate,
  type SubscriptionPermissionUpdate,
  type SubscriptionResponse,
  SyncState,
  type TrackPublishedResponse,
  UpdateSubscription,
} from '../proto/livekit_rtc_pb';
import PCTransport, { PCEvents } from './PCTransport';
import { PCTransportManager, PCTransportState } from './PCTransportManager';
import type { ReconnectContext, ReconnectPolicy } from './ReconnectPolicy';
import type { RegionUrlProvider } from './RegionUrlProvider';
import { roomConnectOptionDefaults } from './defaults';
import {
  ConnectionError,
  ConnectionErrorReason,
  NegotiationError,
  TrackInvalidError,
  UnexpectedConnectionState,
} from './errors';
import { EngineEvent } from './events';
import CriticalTimers from './timers';
import type LocalTrack from './track/LocalTrack';
import type LocalTrackPublication from './track/LocalTrackPublication';
import type LocalVideoTrack from './track/LocalVideoTrack';
import type { SimulcastTrackInfo } from './track/LocalVideoTrack';
import type RemoteTrackPublication from './track/RemoteTrackPublication';
import { Track } from './track/Track';
import type { TrackPublishOptions, VideoCodec } from './track/options';
import { getTrackPublicationInfo } from './track/utils';
import {
  Mutex,
  isVideoCodec,
  isWeb,
  sleep,
  supportsAddTrack,
  supportsSetCodecPreferences,
  supportsTransceiver,
} from './utils';

const lossyDataChannel = '_lossy';
const reliableDataChannel = '_reliable';
const minReconnectWait = 2 * 1000;
const leaveReconnect = 'leave-reconnect';

enum PCState {
  New,
  Connected,
  Disconnected,
  Reconnecting,
  Closed,
}

/** @internal */
export default class RTCEngine extends (EventEmitter as new () => TypedEventEmitter<EngineEventCallbacks>) {
  client: SignalClient;

  rtcConfig: RTCConfiguration = {};

  peerConnectionTimeout: number = roomConnectOptionDefaults.peerConnectionTimeout;

  fullReconnectOnNext: boolean = false;

  pcManager?: PCTransportManager;

  /**
   * @internal
   */
  latestJoinResponse?: JoinResponse;

  get isClosed() {
    return this._isClosed;
  }

  private lossyDC?: RTCDataChannel;

  // @ts-ignore noUnusedLocals
  private lossyDCSub?: RTCDataChannel;

  private reliableDC?: RTCDataChannel;

  private dcBufferStatus: Map<DataPacket_Kind, boolean>;

  // @ts-ignore noUnusedLocals
  private reliableDCSub?: RTCDataChannel;

  private subscriberPrimary: boolean = false;

  private pcState: PCState = PCState.New;

  private _isClosed: boolean = true;

  private pendingTrackResolvers: {
    [key: string]: { resolve: (info: TrackInfo) => void; reject: () => void };
  } = {};

  // keep join info around for reconnect, this could be a region url
  private url?: string;

  private token?: string;

  private signalOpts?: SignalOptions;

  private reconnectAttempts: number = 0;

  private reconnectStart: number = 0;

  private clientConfiguration?: ClientConfiguration;

  private attemptingReconnect: boolean = false;

  private reconnectPolicy: ReconnectPolicy;

  private reconnectTimeout?: ReturnType<typeof setTimeout>;

  private participantSid?: string;

  /** keeps track of how often an initial join connection has been tried */
  private joinAttempts: number = 0;

  /** specifies how often an initial join connection is allowed to retry */
  private maxJoinAttempts: number = 1;

  private closingLock: Mutex;

  private dataProcessLock: Mutex;

  private shouldFailNext: boolean = false;

  private regionUrlProvider?: RegionUrlProvider;

  constructor(private options: InternalRoomOptions) {
    super();
    this.client = new SignalClient();
    this.client.signalLatency = this.options.expSignalLatency;
    this.reconnectPolicy = this.options.reconnectPolicy;
    this.registerOnLineListener();
    this.closingLock = new Mutex();
    this.dataProcessLock = new Mutex();
    this.dcBufferStatus = new Map([
      [DataPacket_Kind.LOSSY, true],
      [DataPacket_Kind.RELIABLE, true],
    ]);

    this.client.onParticipantUpdate = (updates) =>
      this.emit(EngineEvent.ParticipantUpdate, updates);
    this.client.onConnectionQuality = (update) =>
      this.emit(EngineEvent.ConnectionQualityUpdate, update);
    this.client.onRoomUpdate = (update) => this.emit(EngineEvent.RoomUpdate, update);
    this.client.onSubscriptionError = (resp) => this.emit(EngineEvent.SubscriptionError, resp);
    this.client.onSubscriptionPermissionUpdate = (update) =>
      this.emit(EngineEvent.SubscriptionPermissionUpdate, update);
    this.client.onSpeakersChanged = (update) => this.emit(EngineEvent.SpeakersChanged, update);
    this.client.onStreamStateUpdate = (update) => this.emit(EngineEvent.StreamStateChanged, update);
  }

  async join(
    url: string,
    token: string,
    opts: SignalOptions,
    abortSignal?: AbortSignal,
  ): Promise<JoinResponse> {
    this.url = url;
    this.token = token;
    this.signalOpts = opts;
    this.maxJoinAttempts = opts.maxRetries;
    try {
      this.joinAttempts += 1;

      this.setupSignalClientCallbacks();
      const joinResponse = await this.client.join(url, token, opts, abortSignal);
      this._isClosed = false;
      this.latestJoinResponse = joinResponse;

      this.subscriberPrimary = joinResponse.subscriberPrimary;
      if (!this.pcManager) {
        await this.configure(joinResponse);
      }

      // create offer
      if (!this.subscriberPrimary) {
        this.negotiate();
      }

      this.clientConfiguration = joinResponse.clientConfiguration;
      return joinResponse;
    } catch (e) {
      if (e instanceof ConnectionError) {
        if (e.reason === ConnectionErrorReason.ServerUnreachable) {
          log.warn(
            `Couldn't connect to server, attempt ${this.joinAttempts} of ${this.maxJoinAttempts}`,
          );
          if (this.joinAttempts < this.maxJoinAttempts) {
            return this.join(url, token, opts, abortSignal);
          }
        }
      }
      throw e;
    }
  }

  async close() {
    const unlock = await this.closingLock.lock();
    if (this.isClosed) {
      unlock();
      return;
    }
    try {
      this._isClosed = true;
      this.emit(EngineEvent.Closing);
      this.removeAllListeners();
      this.deregisterOnLineListener();
      this.clearPendingReconnect();
      await this.cleanupPeerConnections();
      await this.cleanupClient();
    } finally {
      unlock();
    }
  }

  async cleanupPeerConnections() {
    await this.pcManager?.close();
    this.pcManager = undefined;

    const dcCleanup = (dc: RTCDataChannel | undefined) => {
      if (!dc) return;
      dc.close();
      dc.onbufferedamountlow = null;
      dc.onclose = null;
      dc.onclosing = null;
      dc.onerror = null;
      dc.onmessage = null;
      dc.onopen = null;
    };
    dcCleanup(this.lossyDC);
    dcCleanup(this.lossyDCSub);
    dcCleanup(this.reliableDC);
    dcCleanup(this.reliableDCSub);

    this.lossyDC = undefined;
    this.lossyDCSub = undefined;
    this.reliableDC = undefined;
    this.reliableDCSub = undefined;
  }

  async cleanupClient() {
    await this.client.close();
    this.client.resetCallbacks();
  }

  addTrack(req: AddTrackRequest): Promise<TrackInfo> {
    if (this.pendingTrackResolvers[req.cid]) {
      throw new TrackInvalidError('a track with the same ID has already been published');
    }
    return new Promise<TrackInfo>((resolve, reject) => {
      const publicationTimeout = setTimeout(() => {
        delete this.pendingTrackResolvers[req.cid];
        reject(
          new ConnectionError('publication of local track timed out, no response from server'),
        );
      }, 10_000);
      this.pendingTrackResolvers[req.cid] = {
        resolve: (info: TrackInfo) => {
          clearTimeout(publicationTimeout);
          resolve(info);
        },
        reject: () => {
          clearTimeout(publicationTimeout);
          reject(new Error('Cancelled publication by calling unpublish'));
        },
      };
      this.client.sendAddTrack(req);
    });
  }

  /**
   * Removes sender from PeerConnection, returning true if it was removed successfully
   * and a negotiation is necessary
   * @param sender
   * @returns
   */
  removeTrack(sender: RTCRtpSender): boolean {
    if (sender.track && this.pendingTrackResolvers[sender.track.id]) {
      const { reject } = this.pendingTrackResolvers[sender.track.id];
      if (reject) {
        reject();
      }
      delete this.pendingTrackResolvers[sender.track.id];
    }
    try {
      this.pcManager!.removeTrack(sender);
      return true;
    } catch (e: unknown) {
      log.warn('failed to remove track', { error: e, method: 'removeTrack' });
    }
    return false;
  }

  updateMuteStatus(trackSid: string, muted: boolean) {
    this.client.sendMuteTrack(trackSid, muted);
  }

  get dataSubscriberReadyState(): string | undefined {
    return this.reliableDCSub?.readyState;
  }

  async getConnectedServerAddress(): Promise<string | undefined> {
    return this.pcManager?.getConnectedAddress();
  }

  /* @internal */
  setRegionUrlProvider(provider: RegionUrlProvider) {
    this.regionUrlProvider = provider;
  }

  private async configure(joinResponse: JoinResponse) {
    // already configured
    if (this.pcManager && this.pcManager.currentState !== PCTransportState.NEW) {
      return;
    }

    this.participantSid = joinResponse.participant?.sid;

    const rtcConfig = this.makeRTCConfiguration(joinResponse);

    this.pcManager = new PCTransportManager(rtcConfig, joinResponse.subscriberPrimary);

    this.emit(EngineEvent.TransportsCreated, this.pcManager.publisher, this.pcManager.subscriber);

    this.pcManager.onIceCandidate = (candidate, target) => {
      this.client.sendIceCandidate(candidate, target);
    };

    this.pcManager.onPublisherOffer = (offer) => {
      this.client.sendOffer(offer);
    };

    this.pcManager.onDataChannel = this.handleDataChannel;
    this.pcManager.onStateChange = async (connectionState, publisherState, subscriberState) => {
      log.debug(`primary PC state changed ${connectionState}`);
      if (connectionState === PCTransportState.CONNECTED) {
        const shouldEmit = this.pcState === PCState.New;
        this.pcState = PCState.Connected;
        if (shouldEmit) {
          this.emit(EngineEvent.Connected, joinResponse);
        }
      } else if (connectionState === PCTransportState.FAILED) {
        // on Safari, PeerConnection will switch to 'disconnected' during renegotiation
        if (this.pcState === PCState.Connected) {
          this.pcState = PCState.Disconnected;

          this.handleDisconnect(
            'peerconnection failed',
            subscriberState === 'failed'
              ? ReconnectReason.RR_SUBSCRIBER_FAILED
              : ReconnectReason.RR_PUBLISHER_FAILED,
          );
        }
      }
    };
    this.pcManager.onTrack = (ev: RTCTrackEvent) => {
      this.emit(EngineEvent.MediaTrackAdded, ev.track, ev.streams[0], ev.receiver);
    };

    this.createDataChannels();
  }

  private setupSignalClientCallbacks() {
    // configure signaling client
    this.client.onAnswer = async (sd) => {
      if (!this.pcManager) {
        return;
      }
      log.debug('received server answer', {
        RTCSdpType: sd.type,
      });
      await this.pcManager.setPublisherAnswer(sd);
    };

    // add candidate on trickle
    this.client.onTrickle = (candidate, target) => {
      if (!this.pcManager) {
        return;
      }
      log.trace('got ICE candidate from peer', { candidate, target });
      this.pcManager.addIceCandidate(candidate, target);
    };

    // when server creates an offer for the client
    this.client.onOffer = async (sd) => {
      if (!this.pcManager) {
        return;
      }
      const answer = await this.pcManager.createSubscriberAnswerFromOffer(sd);
      this.client.sendAnswer(answer);
    };

    this.client.onLocalTrackPublished = (res: TrackPublishedResponse) => {
      log.debug('received trackPublishedResponse', res);
      if (!this.pendingTrackResolvers[res.cid]) {
        log.error(`missing track resolver for ${res.cid}`);
        return;
      }
      const { resolve } = this.pendingTrackResolvers[res.cid];
      delete this.pendingTrackResolvers[res.cid];
      resolve(res.track!);
    };

    this.client.onTokenRefresh = (token: string) => {
      this.token = token;
    };

    this.client.onClose = () => {
      this.handleDisconnect('signal', ReconnectReason.RR_SIGNAL_DISCONNECTED);
    };

    this.client.onLeave = (leave?: LeaveRequest) => {
      if (leave?.canReconnect) {
        this.fullReconnectOnNext = true;
        // reconnect immediately instead of waiting for next attempt
        this.handleDisconnect(leaveReconnect);
      } else {
        this.emit(EngineEvent.Disconnected, leave?.reason);
        this.close();
      }
      log.trace('leave request', { leave });
    };
  }

  private makeRTCConfiguration(serverResponse: JoinResponse | ReconnectResponse): RTCConfiguration {
    const rtcConfig = { ...this.rtcConfig };

    if (this.signalOpts?.e2eeEnabled) {
      log.debug('E2EE - setting up transports with insertable streams');
      //  this makes sure that no data is sent before the transforms are ready
      // @ts-ignore
      rtcConfig.encodedInsertableStreams = true;
    }

    // update ICE servers before creating PeerConnection
    if (serverResponse.iceServers && !rtcConfig.iceServers) {
      const rtcIceServers: RTCIceServer[] = [];
      serverResponse.iceServers.forEach((iceServer) => {
        const rtcIceServer: RTCIceServer = {
          urls: iceServer.urls,
        };
        if (iceServer.username) rtcIceServer.username = iceServer.username;
        if (iceServer.credential) {
          rtcIceServer.credential = iceServer.credential;
        }
        rtcIceServers.push(rtcIceServer);
      });
      rtcConfig.iceServers = rtcIceServers;
    }

    if (
      serverResponse.clientConfiguration &&
      serverResponse.clientConfiguration.forceRelay === ClientConfigSetting.ENABLED
    ) {
      rtcConfig.iceTransportPolicy = 'relay';
    }

    // @ts-ignore
    rtcConfig.sdpSemantics = 'unified-plan';
    // @ts-ignore
    rtcConfig.continualGatheringPolicy = 'gather_continually';

    return rtcConfig;
  }

  private createDataChannels() {
    if (!this.pcManager) {
      return;
    }

    // clear old data channel callbacks if recreate
    if (this.lossyDC) {
      this.lossyDC.onmessage = null;
      this.lossyDC.onerror = null;
    }
    if (this.reliableDC) {
      this.reliableDC.onmessage = null;
      this.reliableDC.onerror = null;
    }

    // create data channels
    this.lossyDC = this.pcManager.createPublisherDataChannel(lossyDataChannel, {
      // will drop older packets that arrive
      ordered: true,
      maxRetransmits: 0,
    });
    this.reliableDC = this.pcManager.createPublisherDataChannel(reliableDataChannel, {
      ordered: true,
    });

    // also handle messages over the pub channel, for backwards compatibility
    this.lossyDC.onmessage = this.handleDataMessage;
    this.reliableDC.onmessage = this.handleDataMessage;

    // handle datachannel errors
    this.lossyDC.onerror = this.handleDataError;
    this.reliableDC.onerror = this.handleDataError;

    // set up dc buffer threshold, set to 64kB (otherwise 0 by default)
    this.lossyDC.bufferedAmountLowThreshold = 65535;
    this.reliableDC.bufferedAmountLowThreshold = 65535;

    // handle buffer amount low events
    this.lossyDC.onbufferedamountlow = this.handleBufferedAmountLow;
    this.reliableDC.onbufferedamountlow = this.handleBufferedAmountLow;
  }

  private handleDataChannel = async ({ channel }: RTCDataChannelEvent) => {
    if (!channel) {
      return;
    }
    if (channel.label === reliableDataChannel) {
      this.reliableDCSub = channel;
    } else if (channel.label === lossyDataChannel) {
      this.lossyDCSub = channel;
    } else {
      return;
    }
    log.debug(`on data channel ${channel.id}, ${channel.label}`);
    channel.onmessage = this.handleDataMessage;
  };

  private handleDataMessage = async (message: MessageEvent) => {
    // make sure to respect incoming data message order by processing message events one after the other
    const unlock = await this.dataProcessLock.lock();
    try {
      // decode
      let buffer: ArrayBuffer | undefined;
      if (message.data instanceof ArrayBuffer) {
        buffer = message.data;
      } else if (message.data instanceof Blob) {
        buffer = await message.data.arrayBuffer();
      } else {
        log.error('unsupported data type', message.data);
        return;
      }
      const dp = DataPacket.fromBinary(new Uint8Array(buffer));
      if (dp.value?.case === 'speaker') {
        // dispatch speaker updates
        this.emit(EngineEvent.ActiveSpeakersUpdate, dp.value.value.speakers);
      } else if (dp.value?.case === 'user') {
        this.emit(EngineEvent.DataPacketReceived, dp.value.value, dp.kind);
      }
    } finally {
      unlock();
    }
  };

  private handleDataError = (event: Event) => {
    const channel = event.currentTarget as RTCDataChannel;
    const channelKind = channel.maxRetransmits === 0 ? 'lossy' : 'reliable';

    if (event instanceof ErrorEvent && event.error) {
      const { error } = event.error;
      log.error(`DataChannel error on ${channelKind}: ${event.message}`, error);
    } else {
      log.error(`Unknown DataChannel error on ${channelKind}`, event);
    }
  };

  private handleBufferedAmountLow = (event: Event) => {
    const channel = event.currentTarget as RTCDataChannel;
    const channelKind =
      channel.maxRetransmits === 0 ? DataPacket_Kind.LOSSY : DataPacket_Kind.RELIABLE;

    this.updateAndEmitDCBufferStatus(channelKind);
  };

  private setPreferredCodec(
    transceiver: RTCRtpTransceiver,
    kind: Track.Kind,
    videoCodec: VideoCodec,
  ) {
    if (!('getCapabilities' in RTCRtpSender)) {
      return;
    }
    const cap = RTCRtpSender.getCapabilities(kind);
    if (!cap) return;
    log.debug('get capabilities', cap);
    const matched: RTCRtpCodecCapability[] = [];
    const partialMatched: RTCRtpCodecCapability[] = [];
    const unmatched: RTCRtpCodecCapability[] = [];
    cap.codecs.forEach((c) => {
      const codec = c.mimeType.toLowerCase();
      if (codec === 'audio/opus') {
        matched.push(c);
        return;
      }
      const matchesVideoCodec = codec === `video/${videoCodec}`;
      if (!matchesVideoCodec) {
        unmatched.push(c);
        return;
      }
      // for h264 codecs that have sdpFmtpLine available, use only if the
      // profile-level-id is 42e01f for cross-browser compatibility
      if (videoCodec === 'h264') {
        if (c.sdpFmtpLine && c.sdpFmtpLine.includes('profile-level-id=42e01f')) {
          matched.push(c);
        } else {
          partialMatched.push(c);
        }
        return;
      }

      matched.push(c);
    });

    if (supportsSetCodecPreferences(transceiver)) {
      transceiver.setCodecPreferences(matched.concat(partialMatched, unmatched));
    }
  }

  async createSender(
    track: LocalTrack,
    opts: TrackPublishOptions,
    encodings?: RTCRtpEncodingParameters[],
  ) {
    if (supportsTransceiver()) {
      const sender = await this.createTransceiverRTCRtpSender(track, opts, encodings);
      return sender;
    }
    if (supportsAddTrack()) {
      log.warn('using add-track fallback');
      const sender = await this.createRTCRtpSender(track.mediaStreamTrack);
      return sender;
    }
    throw new UnexpectedConnectionState('Required webRTC APIs not supported on this device');
  }

  async createSimulcastSender(
    track: LocalVideoTrack,
    simulcastTrack: SimulcastTrackInfo,
    opts: TrackPublishOptions,
    encodings?: RTCRtpEncodingParameters[],
  ) {
    // store RTCRtpSender
    if (supportsTransceiver()) {
      return this.createSimulcastTransceiverSender(track, simulcastTrack, opts, encodings);
    }
    if (supportsAddTrack()) {
      log.debug('using add-track fallback');
      return this.createRTCRtpSender(track.mediaStreamTrack);
    }

    throw new UnexpectedConnectionState('Cannot stream on this device');
  }

  private async createTransceiverRTCRtpSender(
    track: LocalTrack,
    opts: TrackPublishOptions,
    encodings?: RTCRtpEncodingParameters[],
  ) {
    if (!this.pcManager) {
      throw new UnexpectedConnectionState('publisher is closed');
    }

    const streams: MediaStream[] = [];

    if (track.mediaStream) {
      streams.push(track.mediaStream);
    }

    const transceiverInit: RTCRtpTransceiverInit = { direction: 'sendonly', streams };
    if (encodings) {
      transceiverInit.sendEncodings = encodings;
    }
    // addTransceiver for react-native is async. web is synchronous, but await won't effect it.
    const transceiver = await this.pcManager.addPublisherTransceiver(
      track.mediaStreamTrack,
      transceiverInit,
    );

    if (track.kind === Track.Kind.Video && opts.videoCodec) {
      this.setPreferredCodec(transceiver, track.kind, opts.videoCodec);
      track.codec = opts.videoCodec;
    }
    return transceiver.sender;
  }

  private async createSimulcastTransceiverSender(
    track: LocalVideoTrack,
    simulcastTrack: SimulcastTrackInfo,
    opts: TrackPublishOptions,
    encodings?: RTCRtpEncodingParameters[],
  ) {
    if (!this.pcManager) {
      throw new UnexpectedConnectionState('publisher is closed');
    }
    const transceiverInit: RTCRtpTransceiverInit = { direction: 'sendonly' };
    if (encodings) {
      transceiverInit.sendEncodings = encodings;
    }
    // addTransceiver for react-native is async. web is synchronous, but await won't effect it.
    const transceiver = await this.pcManager.addPublisherTransceiver(
      simulcastTrack.mediaStreamTrack,
      transceiverInit,
    );
    if (!opts.videoCodec) {
      return;
    }
    this.setPreferredCodec(transceiver, track.kind, opts.videoCodec);
    track.setSimulcastTrackSender(opts.videoCodec, transceiver.sender);
    return transceiver.sender;
  }

  private async createRTCRtpSender(track: MediaStreamTrack) {
    if (!this.pcManager) {
      throw new UnexpectedConnectionState('publisher is closed');
    }
    return this.pcManager.addPublisherTrack(track);
  }

  // websocket reconnect behavior. if websocket is interrupted, and the PeerConnection
  // continues to work, we can reconnect to websocket to continue the session
  // after a number of retries, we'll close and give up permanently
  private handleDisconnect = (connection: string, disconnectReason?: ReconnectReason) => {
    if (this._isClosed) {
      return;
    }

    log.warn(`${connection} disconnected`);
    if (this.reconnectAttempts === 0) {
      // only reset start time on the first try
      this.reconnectStart = Date.now();
    }

    const disconnect = (duration: number) => {
      log.warn(
        `could not recover connection after ${this.reconnectAttempts} attempts, ${duration}ms. giving up`,
      );
      this.emit(EngineEvent.Disconnected);
      this.close();
    };

    const duration = Date.now() - this.reconnectStart;
    let delay = this.getNextRetryDelay({
      elapsedMs: duration,
      retryCount: this.reconnectAttempts,
    });

    if (delay === null) {
      disconnect(duration);
      return;
    }
    if (connection === leaveReconnect) {
      delay = 0;
    }

    log.debug(`reconnecting in ${delay}ms`);

    this.clearReconnectTimeout();
    if (this.token && this.regionUrlProvider) {
      // token may have been refreshed, we do not want to recreate the regionUrlProvider
      // since the current engine may have inherited a regional url
      this.regionUrlProvider.updateToken(this.token);
    }
    this.reconnectTimeout = CriticalTimers.setTimeout(
      () => this.attemptReconnect(disconnectReason),
      delay,
    );
  };

  private async attemptReconnect(reason?: ReconnectReason) {
    if (this._isClosed) {
      return;
    }
    // guard for attempting reconnection multiple times while one attempt is still not finished
    if (this.attemptingReconnect) {
      return;
    }
    if (
      this.clientConfiguration?.resumeConnection === ClientConfigSetting.DISABLED ||
      // signaling state could change to closed due to hardware sleep
      // those connections cannot be resumed
      (this.pcManager?.currentState ?? PCTransportState.NEW) === PCTransportState.NEW
    ) {
      this.fullReconnectOnNext = true;
    }

    try {
      this.attemptingReconnect = true;
      if (this.fullReconnectOnNext) {
        await this.restartConnection();
      } else {
        await this.resumeConnection(reason);
      }
      this.clearPendingReconnect();
      this.fullReconnectOnNext = false;
    } catch (e) {
      this.reconnectAttempts += 1;
      let recoverable = true;
      if (e instanceof UnexpectedConnectionState) {
        log.debug('received unrecoverable error', { error: e });
        // unrecoverable
        recoverable = false;
      } else if (!(e instanceof SignalReconnectError)) {
        // cannot resume
        this.fullReconnectOnNext = true;
      }

      if (recoverable) {
        this.handleDisconnect('reconnect', ReconnectReason.RR_UNKNOWN);
      } else {
        log.info(
          `could not recover connection after ${this.reconnectAttempts} attempts, ${
            Date.now() - this.reconnectStart
          }ms. giving up`,
        );
        this.emit(EngineEvent.Disconnected);
        await this.close();
      }
    } finally {
      this.attemptingReconnect = false;
    }
  }

  private getNextRetryDelay(context: ReconnectContext) {
    try {
      return this.reconnectPolicy.nextRetryDelayInMs(context);
    } catch (e) {
      log.warn('encountered error in reconnect policy', { error: e });
    }

    // error in user code with provided reconnect policy, stop reconnecting
    return null;
  }

  private async restartConnection(regionUrl?: string) {
    try {
      if (!this.url || !this.token) {
        // permanent failure, don't attempt reconnection
        throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
      }

      log.info(`reconnecting, attempt: ${this.reconnectAttempts}`);
      this.emit(EngineEvent.Restarting);

      if (!this.client.isDisconnected) {
        await this.client.sendLeave();
      }
      await this.cleanupPeerConnections();
      await this.cleanupClient();

      let joinResponse: JoinResponse;
      try {
        if (!this.signalOpts) {
          log.warn('attempted connection restart, without signal options present');
          throw new SignalReconnectError();
        }
        // in case a regionUrl is passed, the region URL takes precedence
        joinResponse = await this.join(regionUrl ?? this.url, this.token, this.signalOpts);
      } catch (e) {
        if (e instanceof ConnectionError && e.reason === ConnectionErrorReason.NotAllowed) {
          throw new UnexpectedConnectionState('could not reconnect, token might be expired');
        }
        throw new SignalReconnectError();
      }

      if (this.shouldFailNext) {
        this.shouldFailNext = false;
        throw new Error('simulated failure');
      }

      this.client.setReconnected();
      this.emit(EngineEvent.SignalRestarted, joinResponse);

      await this.waitForPCReconnected();
      this.regionUrlProvider?.resetAttempts();
      // reconnect success
      this.emit(EngineEvent.Restarted);
    } catch (error) {
      const nextRegionUrl = await this.regionUrlProvider?.getNextBestRegionUrl();
      if (nextRegionUrl) {
        await this.restartConnection(nextRegionUrl);
        return;
      } else {
        // no more regions to try (or we're not on cloud)
        this.regionUrlProvider?.resetAttempts();
        throw error;
      }
    }
  }

  private async resumeConnection(reason?: ReconnectReason): Promise<void> {
    if (!this.url || !this.token) {
      // permanent failure, don't attempt reconnection
      throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
    }
    // trigger publisher reconnect
    if (!this.pcManager) {
      throw new UnexpectedConnectionState('publisher and subscriber connections unset');
    }

    log.info(`resuming signal connection, attempt ${this.reconnectAttempts}`);
    this.emit(EngineEvent.Resuming);

    try {
      this.setupSignalClientCallbacks();
      const res = await this.client.reconnect(this.url, this.token, this.participantSid, reason);
      if (res) {
        const rtcConfig = this.makeRTCConfiguration(res);
        this.pcManager.updateConfiguration(rtcConfig);
      }
    } catch (e) {
      let message = '';
      if (e instanceof Error) {
        message = e.message;
        log.error(e.message);
      }
      if (e instanceof ConnectionError && e.reason === ConnectionErrorReason.NotAllowed) {
        throw new UnexpectedConnectionState('could not reconnect, token might be expired');
      }
      throw new SignalReconnectError(message);
    }
    this.emit(EngineEvent.SignalResumed);

    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error('simulated failure');
    }

    await this.pcManager.triggerIceRestart();

    await this.waitForPCReconnected();
    this.client.setReconnected();

    // recreate publish datachannel if it's id is null
    // (for safari https://bugs.webkit.org/show_bug.cgi?id=184688)
    if (this.reliableDC?.readyState === 'open' && this.reliableDC.id === null) {
      this.createDataChannels();
    }

    // resume success
    this.emit(EngineEvent.Resumed);
  }

  async waitForPCInitialConnection(timeout?: number, abortController?: AbortController) {
    if (!this.pcManager) {
      throw new UnexpectedConnectionState('PC manager is closed');
    }
    await this.pcManager.ensurePCTransportConnection(abortController, timeout);
  }

  private async waitForPCReconnected() {
    this.pcState = PCState.Reconnecting;

    log.debug('waiting for peer connection to reconnect');
    try {
      await sleep(minReconnectWait); // FIXME setTimeout again not ideal for a connection critical path
      if (!this.pcManager) {
        throw new UnexpectedConnectionState('PC manager is closed');
      }
      await this.pcManager.ensurePCTransportConnection(undefined, this.peerConnectionTimeout);
      this.pcState = PCState.Connected;
    } catch (e: any) {
      // TODO do we need a `failed` state here for the PC?
      this.pcState = PCState.Disconnected;
      throw new ConnectionError(`could not establish PC connection, ${e.message}`);
    }
  }

  waitForRestarted = () => {
    return new Promise<void>((resolve, reject) => {
      if (this.pcState === PCState.Connected) {
        resolve();
      }
      const onRestarted = () => {
        this.off(EngineEvent.Disconnected, onDisconnected);
        resolve();
      };
      const onDisconnected = () => {
        this.off(EngineEvent.Restarted, onRestarted);
        reject();
      };
      this.once(EngineEvent.Restarted, onRestarted);
      this.once(EngineEvent.Disconnected, onDisconnected);
    });
  };

  /* @internal */
  async sendDataPacket(packet: DataPacket, kind: DataPacket_Kind) {
    const msg = packet.toBinary();

    // make sure we do have a data connection
    await this.ensurePublisherConnected(kind);

    const dc = this.dataChannelForKind(kind);
    if (dc) {
      dc.send(msg);
    }

    this.updateAndEmitDCBufferStatus(kind);
  }

  private updateAndEmitDCBufferStatus = (kind: DataPacket_Kind) => {
    const status = this.isBufferStatusLow(kind);
    if (typeof status !== 'undefined' && status !== this.dcBufferStatus.get(kind)) {
      this.dcBufferStatus.set(kind, status);
      this.emit(EngineEvent.DCBufferStatusChanged, status, kind);
    }
  };

  private isBufferStatusLow = (kind: DataPacket_Kind): boolean | undefined => {
    const dc = this.dataChannelForKind(kind);
    if (dc) {
      return dc.bufferedAmount <= dc.bufferedAmountLowThreshold;
    }
  };

  /**
   * @internal
   */
  async ensureDataTransportConnected(
    kind: DataPacket_Kind,
    subscriber: boolean = this.subscriberPrimary,
  ) {
    if (!this.pcManager) {
      throw new UnexpectedConnectionState('PC manager is closed');
    }
    const transport = subscriber ? this.pcManager.subscriber : this.pcManager.publisher;
    const transportName = subscriber ? 'Subscriber' : 'Publisher';
    if (!transport) {
      throw new ConnectionError(`${transportName} connection not set`);
    }

    if (
      !subscriber &&
      !this.pcManager.publisher.isICEConnected &&
      this.pcManager.publisher.getICEConnectionState() !== 'checking'
    ) {
      // start negotiation
      this.negotiate();
    }

    const targetChannel = this.dataChannelForKind(kind, subscriber);
    if (targetChannel?.readyState === 'open') {
      return;
    }

    // wait until ICE connected
    const endTime = new Date().getTime() + this.peerConnectionTimeout;
    while (new Date().getTime() < endTime) {
      if (
        transport.isICEConnected &&
        this.dataChannelForKind(kind, subscriber)?.readyState === 'open'
      ) {
        return;
      }
      await sleep(50);
    }

    throw new ConnectionError(
      `could not establish ${transportName} connection, state: ${transport.getICEConnectionState()}`,
    );
  }

  private async ensurePublisherConnected(kind: DataPacket_Kind) {
    await this.ensureDataTransportConnected(kind, false);
  }

  /* @internal */
  verifyTransport(): boolean {
    if (!this.pcManager) {
      return false;
    }
    // primary connection
    if (this.pcManager.currentState !== PCTransportState.CONNECTED) {
      return false;
    }

    // ensure signal is connected
    if (!this.client.ws || this.client.ws.readyState === WebSocket.CLOSED) {
      return false;
    }
    return true;
  }

  /** @internal */
  async negotiate(): Promise<void> {
    // observe signal state
    return new Promise<void>(async (resolve, reject) => {
      if (!this.pcManager) {
        reject(new NegotiationError('PC manager is closed'));
        return;
      }

      this.pcManager.requirePublisher();

      const abortController = new AbortController();

      const handleClosed = () => {
        abortController.abort();
        log.debug('engine disconnected while negotiation was ongoing');
        resolve();
        return;
      };

      if (this.isClosed) {
        reject('cannot negotiate on closed engine');
      }
      this.on(EngineEvent.Closing, handleClosed);

      this.pcManager.publisher.once(
        PCEvents.RTPVideoPayloadTypes,
        (rtpTypes: MediaAttributes['rtp']) => {
          const rtpMap = new Map<number, VideoCodec>();
          rtpTypes.forEach((rtp) => {
            const codec = rtp.codec.toLowerCase();
            if (isVideoCodec(codec)) {
              rtpMap.set(rtp.payload, codec);
            }
          });
          this.emit(EngineEvent.RTPVideoMapUpdate, rtpMap);
        },
      );

      try {
        await this.pcManager.negotiate(abortController);
        resolve();
      } catch (e: any) {
        if (e instanceof NegotiationError) {
          this.fullReconnectOnNext = true;
        }
        this.handleDisconnect('negotiation', ReconnectReason.RR_UNKNOWN);
        reject(e);
      } finally {
        this.off(EngineEvent.Closing, handleClosed);
      }
    });
  }

  dataChannelForKind(kind: DataPacket_Kind, sub?: boolean): RTCDataChannel | undefined {
    if (!sub) {
      if (kind === DataPacket_Kind.LOSSY) {
        return this.lossyDC;
      }
      if (kind === DataPacket_Kind.RELIABLE) {
        return this.reliableDC;
      }
    } else {
      if (kind === DataPacket_Kind.LOSSY) {
        return this.lossyDCSub;
      }
      if (kind === DataPacket_Kind.RELIABLE) {
        return this.reliableDCSub;
      }
    }
  }

  /** @internal */
  sendSyncState(remoteTracks: RemoteTrackPublication[], localTracks: LocalTrackPublication[]) {
    if (!this.pcManager) {
      log.warn('sync state cannot be sent without peer connection setup');
      return;
    }
    const previousAnswer = this.pcManager.subscriber.getLocalDescription();
    const previousOffer = this.pcManager.subscriber.getRemoteDescription();

    /* 1. autosubscribe on, so subscribed tracks = all tracks - unsub tracks,
          in this case, we send unsub tracks, so server add all tracks to this
          subscribe pc and unsub special tracks from it.
       2. autosubscribe off, we send subscribed tracks.
    */
    const autoSubscribe = this.signalOpts?.autoSubscribe ?? true;
    const trackSids = new Array<string>();

    remoteTracks.forEach((track) => {
      if (track.isDesired !== autoSubscribe) {
        trackSids.push(track.trackSid);
      }
    });

    this.client.sendSyncState(
      new SyncState({
        answer: previousAnswer
          ? toProtoSessionDescription({
              sdp: previousAnswer.sdp,
              type: previousAnswer.type,
            })
          : undefined,
        offer: previousOffer
          ? toProtoSessionDescription({
              sdp: previousOffer.sdp,
              type: previousOffer.type,
            })
          : undefined,
        subscription: new UpdateSubscription({
          trackSids,
          subscribe: !autoSubscribe,
          participantTracks: [],
        }),
        publishTracks: getTrackPublicationInfo(localTracks),
        dataChannels: this.dataChannelsInfo(),
      }),
    );
  }

  /* @internal */
  failNext() {
    // debugging method to fail the next reconnect/resume attempt
    this.shouldFailNext = true;
  }

  private dataChannelsInfo(): DataChannelInfo[] {
    const infos: DataChannelInfo[] = [];
    const getInfo = (dc: RTCDataChannel | undefined, target: SignalTarget) => {
      if (dc?.id !== undefined && dc.id !== null) {
        infos.push(
          new DataChannelInfo({
            label: dc.label,
            id: dc.id,
            target,
          }),
        );
      }
    };
    getInfo(this.dataChannelForKind(DataPacket_Kind.LOSSY), SignalTarget.PUBLISHER);
    getInfo(this.dataChannelForKind(DataPacket_Kind.RELIABLE), SignalTarget.PUBLISHER);
    getInfo(this.dataChannelForKind(DataPacket_Kind.LOSSY, true), SignalTarget.SUBSCRIBER);
    getInfo(this.dataChannelForKind(DataPacket_Kind.RELIABLE, true), SignalTarget.SUBSCRIBER);
    return infos;
  }

  private clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      CriticalTimers.clearTimeout(this.reconnectTimeout);
    }
  }

  private clearPendingReconnect() {
    this.clearReconnectTimeout();
    this.reconnectAttempts = 0;
  }

  private handleBrowserOnLine = () => {
    // in case the engine is currently reconnecting, attempt a reconnect immediately after the browser state has changed to 'onLine'
    if (this.client.currentState === SignalConnectionState.RECONNECTING) {
      this.clearReconnectTimeout();
      this.attemptReconnect(ReconnectReason.RR_SIGNAL_DISCONNECTED);
    }
  };

  private registerOnLineListener() {
    if (isWeb()) {
      window.addEventListener('online', this.handleBrowserOnLine);
    }
  }

  private deregisterOnLineListener() {
    if (isWeb()) {
      window.removeEventListener('online', this.handleBrowserOnLine);
    }
  }
}

class SignalReconnectError extends Error {}

export type EngineEventCallbacks = {
  connected: (joinResp: JoinResponse) => void;
  disconnected: (reason?: DisconnectReason) => void;
  resuming: () => void;
  resumed: () => void;
  restarting: () => void;
  restarted: () => void;
  signalResumed: () => void;
  signalRestarted: (joinResp: JoinResponse) => void;
  closing: () => void;
  mediaTrackAdded: (
    track: MediaStreamTrack,
    streams: MediaStream,
    receiver?: RTCRtpReceiver,
  ) => void;
  activeSpeakersUpdate: (speakers: Array<SpeakerInfo>) => void;
  dataPacketReceived: (userPacket: UserPacket, kind: DataPacket_Kind) => void;
  transportsCreated: (publisher: PCTransport, subscriber: PCTransport) => void;
  /** @internal */
  trackSenderAdded: (track: Track, sender: RTCRtpSender) => void;
  rtpVideoMapUpdate: (rtpMap: Map<number, VideoCodec>) => void;
  dcBufferStatusChanged: (isLow: boolean, kind: DataPacket_Kind) => void;
  participantUpdate: (infos: ParticipantInfo[]) => void;
  roomUpdate: (room: RoomModel) => void;
  connectionQualityUpdate: (update: ConnectionQualityUpdate) => void;
  speakersChanged: (speakerUpdates: SpeakerInfo[]) => void;
  streamStateChanged: (update: StreamStateUpdate) => void;
  subscriptionError: (resp: SubscriptionResponse) => void;
  subscriptionPermissionUpdate: (update: SubscriptionPermissionUpdate) => void;
};
