"use client";

import { usePlayerStore } from "@/src/lib/stores/player-store";
import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "@/src/i18n/routing";
import Artplayer from "artplayer";
import Hls from "hls.js";
import { ContentLayout } from "@/src/components/dashboard/content-layout";
import { StreamInfo } from "@/src/lib/data/mediainfo/definitions";
import { encodeParams } from "@/src/lib/utils/proxy";
import { getTrueUrl } from "@/src/lib/data/mediainfo/extractor-apis";
import { BASE_PATH } from "@/src/lib/routes";

export default function PlayerPage() {
  const { streamerUrl, mediaInfo, headers } = usePlayerStore();
  const router = useRouter();
  const artRef = useRef<HTMLDivElement>(null);
  const mpegts = useRef<any>(null);
  const playerRef = useRef<Artplayer | null>(null);

  // Consolidated player state
  const playerState = useRef({
    cdn: "",
    format: "",
    bitrate: 0,
    streamInfo: null as StreamInfo | null,
  });


  const buildProxyUrl = useCallback(
    (url: string) => {
      const encodedParams = encodeParams(url, headers);
      return `${BASE_PATH}/api/proxy?data=${encodedParams}`;
    },
    [headers]
  );

  const getUrlAndSwitch = useCallback(
    async (streamInfo: StreamInfo, art: Artplayer) => {
      try {
        const newInfo = await getTrueUrl(streamerUrl!, streamInfo);
        return newInfo ? buildProxyUrl(newInfo.url) : null;
      } catch (error) {
        art.notice.show = "Error getting true url";
        return null;
      }
    },
    [streamerUrl, buildProxyUrl]
  );

  const destroyFlvPlayer = useCallback((art: Artplayer) => {
    try {
      if (art.flv) {
        art.flv.destroy();
        art.flv = null;
      }
    } catch (error) {
      console.error("Error destroying FLV player:", error);
    }
  }, []);

  const getQualities = useCallback(
    (format: string, cdn: string | undefined) => {
      if (!mediaInfo?.streams) return undefined;
      return mediaInfo.streams
        .filter(
          (stream) =>
            stream.format === format &&
            (!cdn || cdn === "" || stream.extras?.cdn === cdn)
        )
        .map((stream: StreamInfo) => ({
          default: stream.url === mediaInfo.streams![0].url,
          html: `${stream.quality || "Default"}`,
          url: stream.url,
        }));
    },
    [mediaInfo]
  );

  const playFlv = useCallback(
    async (
      video: HTMLVideoElement,
      streamInfo: StreamInfo | null,
      url: string,
      art: Artplayer
    ) => {
      if (!mpegts.current.isSupported()) {
        art.notice.show = "Unsupported playback format : flv";
        return;
      }

      destroyFlvPlayer(art);

      if (!streamInfo) {
        art.notice.show = "No stream info";
        return;
      }

      // fix cases when switching quality
      if (streamInfo.url !== url) {
        const stream = mediaInfo!.streams?.find((stream) => stream.url === url);
        if (stream) {
          streamInfo = stream;
        }
      }

      const proxyUrl = await getUrlAndSwitch(streamInfo, art);
      if (!proxyUrl) {
        art.notice.show = "Error getting true url";
        return;
      }

      const flv = mpegts.current.createPlayer({
        type: "flv",
        url: proxyUrl,
        isLive: true,
        cors: true,
      });

      flv.attachMediaElement(video);
      flv.load();
      flv.play();
      art.flv = flv;
      art.on("destroy", () => destroyFlvPlayer(art));
    },
    [getUrlAndSwitch, destroyFlvPlayer]
  );

  const playM3U8 = useCallback(
    async (
      video: HTMLVideoElement,
      streamInfo: StreamInfo | null,
      url: string,
      art: Artplayer
    ) => {
      if (Hls.isSupported()) {
        destroyFlvPlayer(art);
        if (art.hls) art.hls.destroy();

        if (!streamInfo) {
          art.notice.show = "No stream info";
          return;
        }

        // fix cases when switching quality
        if (streamInfo.url !== url) {
          const stream = mediaInfo!.streams?.find(
            (stream) => stream.url === url
          );
          if (stream) {
            streamInfo = stream;
          }
        }

        const proxyUrl = await getUrlAndSwitch(streamInfo, art);
        if (!proxyUrl) {
          art.notice.show = "Error getting true url";
          return;
        }

        const hls = new Hls();
        hls.loadSource(proxyUrl);
        hls.attachMedia(video);
        art.hls = hls;
        art.on("destroy", () => hls.destroy());
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        destroyFlvPlayer(art);
        video.src = url;
      } else {
        art.notice.show = "Unsupported playback format : m3u8";
      }
    },
    [getUrlAndSwitch, destroyFlvPlayer]
  );

  const initializePlayer = useCallback(() => {
    if (!mediaInfo?.streams || !artRef.current) return null;

    if (typeof window !== "undefined") {
      mpegts.current = require("mpegts.js");
    }

    const firstStream =
      mediaInfo.streams.find((stream) => stream.extras?.cdn) ||
      mediaInfo.streams[0];

    console.log("firstStream", firstStream);
    const state = playerState.current;

    state.cdn = firstStream.extras?.cdn || "";
    state.format = firstStream.format;
    state.bitrate = firstStream.bitrate || 0;
    state.streamInfo = firstStream;

    console.log("state", state);

    const controls = [
      {
        position: "right",
        html: mediaInfo.streams[0].format.toUpperCase(),
        index: 2,
        style: {
          marginRight: "20px",
        },
        selector: [
          ...new Set(mediaInfo.streams.map((stream) => stream.format)),
        ].map((format: string) => ({
          html: format.toUpperCase(),
          value: format,
          default: format === state.format,
        })),
        onSelect: async function (item: { html: string; value: string }) {
          console.log("onSelect", item);
          let newStream = mediaInfo.streams!.find(
            (stream: StreamInfo) =>
              stream.format === item.value &&
              (!state.cdn ||
                state.cdn === "" ||
                stream.extras?.cdn === state.cdn) &&
              (stream.bitrate === state.bitrate || !stream.bitrate)
          );

          // if the stream is not found, try to find the next stream with the same format and cdn
          if (!newStream) {
            newStream = mediaInfo.streams!.find(
              (stream: StreamInfo) =>
                stream.format === item.value &&
                (!state.cdn ||
                  state.cdn === "" ||
                  stream.extras?.cdn === state.cdn)
            );
          }

          console.log("newStream", newStream);

          if (newStream) {
            console.log("switching to", newStream);
            state.format = item.value;
            state.bitrate = newStream.bitrate;
            if (newStream.extras?.cdn) {
              state.cdn = newStream.extras?.cdn;
            }
            state.streamInfo = newStream;

            // clear qualities
            art.quality = [];

            art
              .switchQuality(newStream.url)
              .then(() => {
                const newQualities = getQualities(item.value, state.cdn);
                if (newQualities && art) {
                  art.quality = newQualities;
                }
              })
              .catch((error: any) => {
                console.error("Error switching to ", item.value, error);
              });
          }
          return item.html;
        },
      },
    ];

    // Only add CDN control if there are streams with CDNs
    if (mediaInfo.streams.some((stream) => stream.extras?.cdn)) {
      controls.push({
        position: "right",
        html: state.cdn || "Default CDN",
        index: 1,
        style: {
          marginRight: "20px",
        },
        selector: [
          ...new Set(
            mediaInfo.streams
              .filter((stream) => stream.format === state.format)
              .map((stream) => stream.extras?.cdn || "Default")
          ),
        ].map((cdn: string) => ({
          html: cdn,
          value: cdn === "Default" ? "" : cdn,
          default: (cdn === "Default" && !state.cdn) || cdn === state.cdn,
        })),
        onSelect: async function (item: { html: string; value: string }) {
          let newStream = mediaInfo.streams!.find(
            (stream: StreamInfo) =>
              stream.format === state.format &&
              ((!item.value && !stream.extras?.cdn) ||
                stream.extras?.cdn === item.value) &&
              (stream.bitrate === state.bitrate || !stream.bitrate)
          );

          if (!newStream) {
            newStream = mediaInfo.streams!.find(
              (stream: StreamInfo) =>
                stream.format === state.format &&
                ((!item.value && !stream.extras?.cdn) ||
                  stream.extras?.cdn === item.value)
            );
          }

          if (newStream) {
            state.cdn = item.value;
            state.bitrate = newStream.bitrate || 0;
            state.streamInfo = newStream;

            art.quality = [];
            await art.switchQuality(newStream.url);
            const newQualities = getQualities(state.format, item.value);
            if (newQualities && art) {
              art.quality = newQualities;
            }
          }
          return item.html;
        },
      });
    }

    const art = new Artplayer({
      container: artRef.current,
      url: firstStream.url,
      customType: {
        flv: function (video, url, art) {
          playFlv(video, state.streamInfo, url, art);
        },
        m3u8: function (video, url, art) {
          playM3U8(video, state.streamInfo, url, art);
        },
      },
      volume: 0.3,
      isLive: true,
      muted: false,
      autoplay: false,
      pip: true,
      autoSize: true,
      autoMini: true,
      screenshot: false,
      setting: true,
      loop: true,
      flip: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      subtitleOffset: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      autoPlayback: true,
      airplay: true,
      useSSR: false,
      quality: getQualities(state.format, state.cdn),
      lang: navigator.language.toLowerCase(),
      controls,
    });

    playerRef.current = art;
    return art;
  }, []);

  useEffect(() => {
    if (!mediaInfo?.streams || !headers) {
      router.push("/playground");
      return;
    }

    const art = initializePlayer();

    return () => {
      if (playerRef.current) {
        playerRef.current.destroy(false);
        playerRef.current = null;
      }
    };
  }, [mediaInfo, headers, router, initializePlayer]);

  if (!mediaInfo?.streams || !headers) {
    return null;
  }

  return (
    <ContentLayout title="Player">
      <div ref={artRef} className="w-[80%] aspect-video" />
    </ContentLayout>
  );
}
