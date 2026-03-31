import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';

export function useLiveAPI() {
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const dummyGainRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  const connect = useCallback(async () => {
    try {
      setError(null);
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      await audioContextRef.current.resume();

      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      sourceRef.current = audioContextRef.current.createMediaStreamSource(streamRef.current);
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      // Mute the local playback to avoid echo, but keep it connected so onaudioprocess fires in Chrome
      dummyGainRef.current = audioContextRef.current.createGain();
      dummyGainRef.current.gain.value = 0;
      processorRef.current.connect(dummyGainRef.current);
      dummyGainRef.current.connect(audioContextRef.current.destination);
      sourceRef.current.connect(processorRef.current);

      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "Bạn là hướng dẫn viên Quảng Trị. Hãy trả lời cực kỳ ngắn gọn, đi thẳng vào vấn đề (dưới 2 câu). Không chào hỏi dài dòng.",
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            processorRef.current!.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                let s = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              
              // Safe base64 conversion to avoid "Maximum call stack size exceeded"
              const uint8Array = new Uint8Array(pcm16.buffer);
              let binary = '';
              for (let i = 0; i < uint8Array.byteLength; i++) {
                binary += String.fromCharCode(uint8Array[i]);
              }
              const base64Data = btoa(binary);
              
              sessionPromise.then((session: any) => {
                session.sendRealtimeInput({
                  audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              }).catch(console.error);
            };
          },
          onmessage: async (message: any) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              setIsSpeaking(true);
              const binary = atob(base64Audio);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const pcm16 = new Int16Array(bytes.buffer);
              const audioBuffer = audioContextRef.current.createBuffer(1, pcm16.length, 24000);
              const channelData = audioBuffer.getChannelData(0);
              for (let i = 0; i < pcm16.length; i++) {
                channelData[i] = pcm16[i] / 32768.0;
              }
              const source = audioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioContextRef.current.destination);
              
              if (nextPlayTimeRef.current < audioContextRef.current.currentTime) {
                nextPlayTimeRef.current = audioContextRef.current.currentTime;
              }
              source.start(nextPlayTimeRef.current);
              nextPlayTimeRef.current += audioBuffer.duration;
              
              source.onended = () => {
                if (audioContextRef.current && audioContextRef.current.currentTime >= nextPlayTimeRef.current - 0.1) {
                  setIsSpeaking(false);
                }
              };
            }
            if (message.serverContent?.interrupted) {
              setIsSpeaking(false);
              nextPlayTimeRef.current = 0;
            }
          },
          onclose: () => {
            disconnect();
          },
          onerror: (err: any) => {
            console.error(err);
            setError("Lỗi kết nối Live API");
            disconnect();
          }
        }
      });
      
      sessionRef.current = sessionPromise;

    } catch (err: any) {
      console.error(err);
      if (err.name === 'NotAllowedError' || err.message === 'Permission denied') {
        setError("Trình duyệt đã từ chối quyền truy cập Micro. Vui lòng kiểm tra cài đặt trình duyệt hoặc mở trang web này trong một tab mới.");
      } else {
        setError(err.message || "Không thể truy cập micro. Vui lòng kiểm tra lại thiết bị.");
      }
      disconnect();
    }
  }, []);

  const disconnect = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
    }
    if (dummyGainRef.current) {
      dummyGainRef.current.disconnect();
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(console.error);
    }
    if (sessionRef.current) {
      sessionRef.current.then((s: any) => s.close()).catch(console.error);
    }
    setIsConnected(false);
    setIsSpeaking(false);
    nextPlayTimeRef.current = 0;
  }, []);

  return { isConnected, isSpeaking, error, connect, disconnect };
}
