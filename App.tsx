
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionStatus, Message, AppConfig } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import VoiceVisualizer from './components/VoiceVisualizer';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  
  const [config, setConfig] = useState<AppConfig>({
    systemInstruction: 'Loading...',
    voiceName: 'Puck'
  });
  
  // Fetch configuration from Netlify Function on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        // Netlify function endpoint
        const response = await fetch('/.netlify/functions/config');
        if (response.ok) {
          const data = await response.json();
          setConfig({
            systemInstruction: data.systemInstruction,
            voiceName: data.voiceName
          });
        } else {
          throw new Error("Backend response not ok");
        }
      } catch (err) {
        console.error("Failed to load Netlify config, using fallback.");
        setConfig({
          systemInstruction: "You are a helpful assistant speaking in Bangla.",
          voiceName: "Puck"
        });
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
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
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
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 animate-pulse font-mono uppercase tracking-widest text-xs">Syncing with Netlify Node.js Backend...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full items-center justify-center p-4 md:p-8 bg-[#0a0a0a] text-white overflow-hidden relative">
      
      {/* Settings Panel */}
      <button 
        onClick={() => setShowSettings(!showSettings)}
        className="absolute top-8 right-8 z-50 glass p-3 rounded-full hover:bg-white/10 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      </button>

      {showSettings && (
        <div className="fixed inset-y-0 right-0 w-80 glass z-40 p-6 shadow-2xl animate-in slide-in-from-right duration-300">
          <h2 className="text-xl font-bold mb-2">Instructions</h2>
          <p className="text-[10px] text-green-400 mb-6 font-mono uppercase tracking-widest">Synced with Netlify Backend</p>
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">System Instruction</label>
              <textarea 
                className="w-full h-40 bg-black/40 border border-white/10 rounded-lg p-3 text-sm focus:border-blue-500 outline-none transition-colors"
                value={config.systemInstruction}
                onChange={(e) => setConfig({...config, systemInstruction: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Voice Model</label>
              <select 
                className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm outline-none"
                value={config.voiceName}
                onChange={(e) => setConfig({...config, voiceName: e.target.value as any})}
              >
                <option value="Puck">Puck (Energetic)</option>
                <option value="Charon">Charon (Deep)</option>
                <option value="Kore">Kore (Soft)</option>
                <option value="Fenrir">Fenrir (Calm)</option>
                <option value="Zephyr">Zephyr (Balanced)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="absolute top-8 text-center">
        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
          Gemini Voice Live
        </h1>
        <p className="text-gray-400 mt-2 text-sm uppercase tracking-widest font-medium">
          Netlify Node.js Powered
        </p>
      </div>

      <div className="flex flex-col items-center justify-center w-full max-w-2xl flex-grow space-y-8">
        <VoiceVisualizer isActive={status === ConnectionStatus.CONNECTED} isSpeaking={isSpeaking} volume={volume} />
        <div className="h-24 w-full text-center px-4 flex items-center justify-center">
          <p className="text-xl md:text-2xl font-light text-gray-200">
            {currentTranscription || (status === ConnectionStatus.CONNECTED ? 'Listening...' : 'বটনের ক্লিক করে কথা শুরু করুন')}
          </p>
        </div>
        <button
          onClick={status === ConnectionStatus.CONNECTED ? disconnect : connect}
          className={`px-12 py-4 rounded-full text-lg font-bold transition-all shadow-2xl ${
            status === ConnectionStatus.CONNECTED ? 'bg-red-500 shadow-red-500/30' : 'bg-gradient-to-r from-blue-600 to-purple-600 shadow-blue-500/30'
          }`}
          disabled={status === ConnectionStatus.CONNECTING}
        >
          {status === ConnectionStatus.CONNECTED ? 'Stop Session' : 'Start Live Mode'}
        </button>
      </div>

      <div className="absolute bottom-8 flex space-x-4 items-center glass px-6 py-2 rounded-full text-xs text-gray-400">
        <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500' : 'bg-gray-500'}`} />
        <span className="font-mono uppercase">{status}</span>
      </div>
    </div>
  );
};

export default App;
