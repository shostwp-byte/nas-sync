'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch, Lock, ShieldCheck, User } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || 'Đăng nhập thất bại.');
        return;
      }
      router.push('/');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md bg-slate-900/90 backdrop-blur border border-slate-800 rounded-2xl p-8 shadow-2xl relative z-10">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-blue-500/25 mb-4">
            <ShieldCheck className="w-8 h-8 text-slate-950 stroke-[2.2]" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">
            NAS-SYNC PLATFORM
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Hệ thống Sao lưu & Khôi phục Tập trung trên Synology NAS (Open Source)
          </p>
        </div>

        {error && (
          <div className="mb-5 p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-xs text-rose-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Tài khoản Quản trị
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="w-full bg-slate-950 border border-slate-800 focus:border-blue-500 rounded-lg pl-10 pr-3.5 py-2.5 text-sm text-white outline-none transition-colors"
                placeholder="Nhập tên đăng nhập..."
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Mật khẩu
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full bg-slate-950 border border-slate-800 focus:border-blue-500 rounded-lg pl-10 pr-3.5 py-2.5 text-sm text-white outline-none transition-colors"
                placeholder="Nhập mật khẩu quản trị..."
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm shadow-lg shadow-blue-600/20 transition-all"
          >
            {loading ? 'Đang xác thực...' : 'Đăng nhập Hệ thống'}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
          <a
            href="https://github.com/shostwp-byte/nas-sync"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-blue-400 transition-colors"
          >
            <GitBranch className="w-3.5 h-3.5 text-blue-400" />
            shostwp-byte/nas-sync (MIT)
          </a>
          <span>Free & Open Source</span>
        </div>
      </div>
    </div>
  );
}
