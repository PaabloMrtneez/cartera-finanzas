/**
 * Solo pone el título de la pestaña: la página es de cliente y no puede
 * exportar `metadata`. El marco de acceso lo da el layout del grupo.
 */
export const metadata = { title: "Invitación" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
