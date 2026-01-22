
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionStatus, AppConfig } from './types.ts';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils.ts';
import VoiceVisualizer from './VoiceVisualizer.tsx';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  
  const [config, setConfig] = useState<AppConfig>({
    systemInstruction: 'আপনি একজন দক্ষ বাংলা এআই অ্যাসিস্ট্যান্ট।',
    voiceName: 'Puck'
  });
  
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch('/.netlify/functions/config').catch(() => null);
        if (response && response.ok) {
          const data = await response.json();
          setConfig({
            systemInstruction: data.systemInstruction || config.systemInstruction,
            voiceName: data.voiceName || config.voiceName
          });
        }
      } catch (err) {
        console.warn("Config fetch failed", err);
      } finally {
        // Minimum delay for aesthetics
        setTimeout(() => setIsConfigLoading(false), 800);
      }
    };

    loadConfig();
  }, []);
  
  const audioContextRef = useRef<{
    input: AudioContext;
    output: AudioContext;
  } | null>(null);
  
  const sessionRef = useRef<any>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const transcriptionRef = useRef<{ user: string; model: string }>({ user: '', model: '' });

  const stopAllAudio = useCallback(() => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
  }, []);

  const connect = async () => {
    if (status !== ConnectionStatus.DISCONNECTED) return;
    setStatus(ConnectionStatus.CONNECTING);
    
    try {
      const apiKey = (process.env as any).API_KEY;
      const ai = new GoogleGenAI({ apiKey });
      
      if (!audioContextRef.current) {
        audioContextRef.current = {
          input: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 }),
          output: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 })
        };
      }

      const { input: inputCtx, output: outputCtx } = audioContextRef.current;
      await inputCtx.resume();
      await outputCtx.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } },
          },
          systemInstruction: config.systemInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));

              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              transcriptionRef.current.user += message.serverContent.inputTranscription.text;
              setCurrentTranscription(`আপনি: ${transcriptionRef.current.user}`);
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.model += message.serverContent.outputTranscription.text;
              setCurrentTranscription(`জেমিনি: ${transcriptionRef.current.model}`);
            }
            if (message.serverContent?.turnComplete) {
              transcriptionRef.current = { user: '', model: '' };
            }
            if (message.serverContent?.interrupted) {
              stopAllAudio();
            }
          },
          onerror: (e) => setStatus(ConnectionStatus.ERROR),
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED),
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Connection failed:", err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    stopAllAudio();
    setStatus(ConnectionStatus.DISCONNECTED);
    setVolume(0);
    setCurrentTranscription('');
  }, [stopAllAudio]);

  if (isConfigLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0a0a0a]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono text-[10px] tracking-widest uppercase">Initializing Gemini...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full items-center justify-center p-4 bg-[#0a0a0a] text-white overflow-hidden relative">
      <div className="text-center absolute top-12">
        <h1 className="text-2xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-b from-white to-gray-500 uppercase">
          Gemini Voice Live
        </h1>
        <div className="h-0.5 w-10 bg-blue-600 mx-auto mt-2 opacity-50"></div>
      </div>

      <div className="flex flex-col items-center justify-center w-full max-w-lg flex-grow space-y-12">
        <VoiceVisualizer isActive={status === ConnectionStatus.CONNECTED} isSpeaking={isSpeaking} volume={volume} />
        
        <div className="h-20 w-full text-center px-6 overflow-hidden">
          <p className="text-lg font-medium text-gray-300">
            {currentTranscription || (status === ConnectionStatus.CONNECTED ? 'Listening...' : 'বটটির সাথে কথা বলতে নিচে ক্লিক করুন')}
          </p>
        </div>

        <button
          onClick={status === ConnectionStatus.CONNECTED ? disconnect : connect}
          className={`px-10 py-4 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-95 ${
            status === ConnectionStatus.CONNECTED 
            ? 'bg-white text-black hover:bg-gray-200' 
            : 'bg-blue-600 text-white hover:bg-blue-500 shadow-[0_0_30px_rgba(37,99,235,0.2)]'
          } disabled:opacity-50`}
          disabled={status === ConnectionStatus.CONNECTING}
        >
          {status === ConnectionStatus.CONNECTED ? 'End Session' : 'Start Session'}
        </button>
      </div>

      <div className="absolute bottom-10 flex items-center space-x-2 bg-white/5 px-4 py-2 rounded-full border border-white/5">
        <div className={`w-1.5 h-1.5 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`} />
        <span className="text-[10px] font-mono font-bold text-gray-400 tracking-widest uppercase">{status}</span>
      </div>
    </div>
  );
};

export default App;
