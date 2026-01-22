
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionStatus, Message, AppConfig } from './types.ts';
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch('/.netlify/functions/config', { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          setConfig({
            systemInstruction: data.systemInstruction || config.systemInstruction,
            voiceName: data.voiceName || config.voiceName
          });
          console.log("Config loaded successfully");
        }
      } catch (err) {
        console.warn("Config fetch failed, using defaults", err);
      } finally {
        setIsConfigLoading(false);
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
      // Create a new instance right before use as per guidelines to ensure fresh API key context
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
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
              // Ensure sendRealtimeInput is called after connection promise resolves to avoid race conditions
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
              // Use addEventListener for robust cleanup as per guidelines
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
          onerror: (e) => {
            console.error("Session error:", e);
            setStatus(ConnectionStatus.ERROR);
          },
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
      <div className="flex h-screen w-full items-center justify-center bg-[#0a0a0a] text-white">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-500 font-mono text-[10px] tracking-widest uppercase">Booting System...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full items-center justify-center p-4 bg-[#0a0a0a] text-white overflow-hidden relative font-sans">
      
      <button 
        onClick={() => setShowSettings(!showSettings)}
        className="absolute top-6 right-6 z-50 glass p-3 rounded-full hover:bg-white/10 transition-all active:scale-95"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      </button>

      {showSettings && (
        <div className="fixed inset-y-0 right-0 w-72 glass z-40 p-6 shadow-2xl animate-in slide-in-from-right duration-300">
          <h2 className="text-lg font-bold mb-1">Configuration</h2>
          <p className="text-[9px] text-blue-400 mb-6 font-mono uppercase tracking-widest">Engine: Gemini 2.5 Flash</p>
          <div className="space-y-5">
            <div>
              <label className="block text-[11px] font-bold text-gray-500 uppercase mb-2">Instruction</label>
              <textarea 
                className="w-full h-32 bg-black/40 border border-white/5 rounded-lg p-3 text-sm focus:border-blue-500/50 outline-none transition-all resize-none"
                value={config.systemInstruction}
                onChange={(e) => setConfig({...config, systemInstruction: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-gray-500 uppercase mb-2">Voice Tone</label>
              <select 
                className="w-full bg-black/40 border border-white/5 rounded-lg p-3 text-sm outline-none appearance-none"
                value={config.voiceName}
                onChange={(e) => setConfig({...config, voiceName: e.target.value as any})}
              >
                <option value="Puck">Puck (Cheerful)</option>
                <option value="Charon">Charon (Deep)</option>
                <option value="Kore">Kore (Soft)</option>
                <option value="Fenrir">Fenrir (Steady)</option>
                <option value="Zephyr">Zephyr (Balanced)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      <div className="text-center absolute top-12">
        <h1 className="text-2xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-b from-white to-gray-500">
          GEMINI VOICE
        </h1>
        <div className="h-px w-12 bg-blue-600 mx-auto mt-2 opacity-50"></div>
      </div>

      <div className="flex flex-col items-center justify-center w-full max-w-lg flex-grow space-y-12">
        <div className="relative">
          <VoiceVisualizer isActive={status === ConnectionStatus.CONNECTED} isSpeaking={isSpeaking} volume={volume} />
          {status === ConnectionStatus.CONNECTING && (
             <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-24 h-24 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
             </div>
          )}
        </div>
        
        <div className="h-20 w-full text-center px-6 overflow-hidden">
          <p className="text-lg md:text-xl font-medium text-gray-300 transition-all duration-300">
            {currentTranscription || (status === ConnectionStatus.CONNECTED ? 'Listening...' : 'বটটির সাথে কথা বলতে নিচের বাটনে ক্লিক করুন')}
          </p>
        </div>

        <button
          onClick={status === ConnectionStatus.CONNECTED ? disconnect : connect}
          className={`group relative overflow-hidden px-10 py-4 rounded-xl text-sm font-black uppercase tracking-widest transition-all ${
            status === ConnectionStatus.CONNECTED 
            ? 'bg-white text-black hover:bg-gray-200' 
            : 'bg-blue-600 text-white hover:bg-blue-500 shadow-[0_0_30px_rgba(37,99,235,0.3)]'
          } disabled:opacity-50 active:scale-95`}
          disabled={status === ConnectionStatus.CONNECTING}
        >
          {status === ConnectionStatus.CONNECTED ? 'End Conversation' : 'Start Session'}
        </button>
      </div>

      <div className="absolute bottom-10 flex items-center space-x-3 bg-white/5 px-4 py-2 rounded-full border border-white/5">
        <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${
          status === ConnectionStatus.CONNECTED ? 'bg-green-500' : status === ConnectionStatus.ERROR ? 'bg-red-500' : 'bg-gray-600'
        }`} />
        <span className="text-[10px] font-mono font-bold text-gray-400 tracking-widest uppercase">{status}</span>
      </div>
    </div>
  );
};

export default App;
