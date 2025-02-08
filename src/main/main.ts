import {
  Crypto,
  DownloadManager,
  logger,
  Ludusavi,
  startMainLoop,
} from "./services";
import { RealDebridClient } from "./services/download/real-debrid";
import { AllDebridClient } from "./services/download/all-debrid";
import { HydraApi } from "./services/hydra-api";
import { uploadGamesBatch } from "./services/library-sync";
import { Aria2 } from "./services/aria2";
import { downloadsSublevel } from "./level/sublevels/downloads";
import { sortBy } from "lodash-es";
import { Downloader } from "@shared";
import {
  gameAchievementsSublevel,
  gamesSublevel,
  levelKeys,
  db,
} from "./level";
import { Auth, User, type UserPreferences } from "@types";
import { knexClient } from "./knex-client";
import { TorBoxClient } from "./services/download/torbox";

export const loadState = async () => {
  const userPreferences = await migrateFromSqlite().then(async () => {
    await db.put<string, boolean>(levelKeys.sqliteMigrationDone, true, {
      valueEncoding: "json",
    });

    return db.get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    });
  });

  await import("./events");

  Aria2.spawn();

  if (userPreferences?.realDebridApiToken) {
    RealDebridClient.authorize(
      Crypto.decrypt(userPreferences.realDebridApiToken)
    );
  }

  if (userPreferences?.allDebridApiKey) {
      AllDebridClient.authorize(
        Crypto.decrypt(userPreferences.allDebridApiKey)
      );
  }

  if (userPreferences?.torBoxApiToken) {
    TorBoxClient.authorize(
      Crypto.decrypt(userPreferences.torBoxApiToken)
    );
  }

  Ludusavi.addManifestToLudusaviConfig();

  HydraApi.setupApi().then(() => {
    uploadGamesBatch();
  });

  const downloads = await downloadsSublevel
    .values()
    .all()
    .then((games) => {
      return sortBy(
        games.filter((game) => game.queued),
        "timestamp",
        "DESC"
      );
    });

  const [nextItemOnQueue] = downloads;

  const downloadsToSeed = downloads.filter(
    (download) =>
      download.shouldSeed &&
      download.downloader === Downloader.Torrent &&
      download.progress === 1 &&
      download.uri !== null
  );

  await DownloadManager.startRPC(nextItemOnQueue, downloadsToSeed);

  startMainLoop();
};

const migrateFromSqlite = async () => {
  const sqliteMigrationDone = await db.get(levelKeys.sqliteMigrationDone);

  if (sqliteMigrationDone) {
    return;
  }

  const migrateGames = knexClient("game")
    .select("*")
    .then((games) => {
      return gamesSublevel.batch(
        games.map((game) => ({
          type: "put",
          key: levelKeys.game(game.shop, game.objectID),
          value: {
            objectId: game.objectID,
            shop: game.shop,
            title: game.title,
            iconUrl: game.iconUrl,
            playTimeInMilliseconds: game.playTimeInMilliseconds,
            lastTimePlayed: game.lastTimePlayed,
            remoteId: game.remoteId,
            winePrefixPath: game.winePrefixPath,
            launchOptions: game.launchOptions,
            executablePath: game.executablePath,
            isDeleted: game.isDeleted === 1,
          },
        }))
      );
    })
    .then(() => {
      logger.info("Games migrated successfully");
    });

  const migrateUserPreferences = knexClient("user_preferences")
    .select("*")
    .then(async (userPreferences) => {
      if (userPreferences.length > 0) {
        const { realDebridApiToken, allDebridApiKey, ...rest } = userPreferences[0];

        await db.put<string, UserPreferences>(
          levelKeys.userPreferences,
          {
            ...rest,
            realDebridApiToken: realDebridApiToken
              ? Crypto.encrypt(realDebridApiToken)
              : null,
            allDebridApiKey: allDebridApiKey
              ? Crypto.encrypt(allDebridApiKey)
              : null,
            preferQuitInsteadOfHiding: rest.preferQuitInsteadOfHiding === 1,
            runAtStartup: rest.runAtStartup === 1,
            startMinimized: rest.startMinimized === 1,
            disableNsfwAlert: rest.disableNsfwAlert === 1,
            seedAfterDownloadComplete: rest.seedAfterDownloadComplete === 1,
            showHiddenAchievementsDescription:
              rest.showHiddenAchievementsDescription === 1,
            downloadNotificationsEnabled:
              rest.downloadNotificationsEnabled === 1,
            repackUpdatesNotificationsEnabled:
              rest.repackUpdatesNotificationsEnabled === 1,
            achievementNotificationsEnabled:
              rest.achievementNotificationsEnabled === 1,
          },
          { valueEncoding: "json" }
        );

        if (rest.language) {
          await db.put(levelKeys.language, rest.language);
        }
      }
    })
    .then(() => {
      logger.info("User preferences migrated successfully");
    });

  const migrateAchievements = knexClient("game_achievement")
    .select("*")
    .then((achievements) => {
      return gameAchievementsSublevel.batch(
        achievements.map((achievement) => ({
          type: "put",
          key: levelKeys.game(achievement.shop, achievement.objectId),
          value: {
            achievements: JSON.parse(achievement.achievements),
            unlockedAchievements: JSON.parse(achievement.unlockedAchievements),
          },
        }))
      );
    })
    .then(() => {
      logger.info("Achievements migrated successfully");
    });

  const migrateUser = knexClient("user_auth")
    .select("*")
    .then(async (users) => {
      if (users.length > 0) {
        await db.put<string, User>(
          levelKeys.user,
          {
            id: users[0].userId,
            displayName: users[0].displayName,
            profileImageUrl: users[0].profileImageUrl,
            backgroundImageUrl: users[0].backgroundImageUrl,
            subscription: users[0].subscription,
          },
          {
            valueEncoding: "json",
          }
        );

        await db.put<string, Auth>(
          levelKeys.auth,
          {
            accessToken: Crypto.encrypt(users[0].accessToken),
            refreshToken: Crypto.encrypt(users[0].refreshToken),
            tokenExpirationTimestamp: users[0].tokenExpirationTimestamp,
          },
          {
            valueEncoding: "json",
          }
        );
      }
    })
    .then(() => {
      logger.info("User data migrated successfully");
    });

  return Promise.allSettled([
    migrateGames,
    migrateUserPreferences,
    migrateAchievements,
    migrateUser,
  ]);
};
