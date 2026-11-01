import { useNavigate } from "react-router";

import { MobileSignInPanel } from "../components/sign-in";

export const Component = () => {
  const navigate = useNavigate();

  return <MobileSignInPanel onClose={() => navigate("/")} />;
};
