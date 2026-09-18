import { useTVDirector } from '../hooks/useTVDirector';

/**
 * TV Director Controller — обёртка для hook'а.
 * Прокидывает камеры через useThree.
 */
export function TVDirectorController() {
  useTVDirector();
  return null;
}

export default TVDirectorController;
