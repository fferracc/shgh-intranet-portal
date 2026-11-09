"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useState } from "react";
import { Mail, Lock, LogIn, AlertCircle, Eye, EyeOff } from "lucide-react";

import Image from "next/image";

export default function LoginPage() {
  const { signInWithEmail, resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessMessage("");
    setLoading(true);
    try {
      await signInWithEmail(email.trim(), password);
    } catch (err: any) {
      const errorMessage = err.message || "Failed to sign in";
      if (errorMessage.includes("auth/invalid-credential") || errorMessage.includes("auth/wrong-password") || errorMessage.includes("auth/user-not-found")) {
        setError("Invalid email or password.");
      } else if (errorMessage.includes("auth/too-many-requests")) {
        setError("Too many failed attempts. Please try again later.");
      } else {
        setError(errorMessage);
      }
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError("Please enter your email address to reset your password.");
      return;
    }
    setError("");
    setSuccessMessage("");
    setLoading(true);
    try {
      await resetPassword(email.trim());
      setSuccessMessage("Password reset email sent! Check your inbox.");
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes("auth/user-not-found")) {
        // For security, it's often better to show a generic message, but we'll show specific here given internal portal context
        setError("No account found with this email.");
      } else {
        setError("Failed to send reset email. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center mb-6">
          <img
            src="/assets/logo.png"
            alt="Sovereign House GH"
            className="h-28 w-auto drop-shadow-sm"
          />
        </div>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-[#2c4a00]">
          Management Portal
        </h2>
        <p className="mt-2 text-center text-sm text-slate-600 font-medium">
          Secure Access Terminal
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-10 px-6 shadow-xl sm:rounded-2xl sm:px-10 border border-slate-100 relative overflow-hidden">

          {/* Subtle top accent bar */}
          <div className="absolute top-0 left-0 w-full h-1 bg-[#2c4a00]"></div>

          {(error || successMessage) && (
            <div className={`mb-6 p-4 rounded-lg flex items-start gap-3 text-sm break-words ${error ? 'bg-red-50 text-red-800 border-l-4 border-red-500' : 'bg-green-50 text-green-800 border-l-4 border-green-500'}`}>
              <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
              <span>{error || successMessage}</span>
            </div>
          )}

          <form className="space-y-6" onSubmit={handleEmailLogin}>
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-slate-700">
                Email Address
              </label>
              <div className="mt-2 relative rounded-lg shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Mail size={18} />
                </div>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full pl-10 sm:text-sm border-slate-200 rounded-lg focus:ring-[#2c4a00] focus:border-[#2c4a00] text-slate-900 bg-slate-50 py-3 transition-colors outline-none"
                  placeholder="name@sovereignhousegh.com"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-slate-700">
                Password
              </label>
              <div className="mt-2 relative rounded-lg shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock size={18} />
                </div>
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-10 pr-10 sm:text-sm border-slate-200 rounded-lg focus:ring-[#2c4a00] focus:border-[#2c4a00] text-slate-900 bg-slate-50 py-3 transition-colors outline-none"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-[#2c4a00] focus:outline-none transition-colors"
                >
                  {showPassword ? (
                    <EyeOff size={20} className="text-slate-400" />
                  ) : (
                    <Eye size={20} className="text-slate-400" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end">
              <div className="text-sm">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={loading}
                  className="font-bold text-[#7f4c12] hover:text-[#5e380d] transition-colors disabled:opacity-50"
                >
                  Forgot your password?
                </button>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-3.5 px-4 border border-transparent rounded-xl shadow-sm shadow-[#7f4c12]/20 text-sm font-bold text-white bg-[#7f4c12] hover:bg-[#5e380d] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#7f4c12] transition-all disabled:opacity-50 items-center gap-2 active:scale-[0.98]"
              >
                {loading ? "Signing in..." : (
                  <>
                    Sign In
                    <LogIn size={18} />
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Footer Info */}
      <div className="mt-10 text-center sm:mx-auto sm:w-full sm:max-w-md">
        <p className="text-[11px] text-slate-400 uppercase tracking-widest font-bold">
          © {new Date().getFullYear()} Sovereign House GH. All rights reserved.
        </p>
      </div>
    </div>
  );
}

