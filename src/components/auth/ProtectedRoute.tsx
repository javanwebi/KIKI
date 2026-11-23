import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { portalContentService } from "../../services/portalContentService";

interface ProtectedRouteProps {
  children: React.ReactNode;
  portalType?: "consumer" | "high_volume";
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
}) => {
  const { authLoading } = useAuth();

  if (authLoading)
    return (
      <div role="status" className="py-24 text-center text-[#55565A]">
        در حال بررسی حساب…
      </div>
    );

  return <>{children}</>;
};
