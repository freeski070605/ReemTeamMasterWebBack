import passport from 'passport';
import {
  Strategy as FacebookStrategy,
  type Profile as FacebookProfile,
  type VerifyFunction,
} from 'passport-facebook';
import User from '../models/User';

const facebookAppId = process.env.FACEBOOK_APP_ID;
const facebookAppSecret = process.env.FACEBOOK_APP_SECRET;
const facebookRedirectUri = process.env.FACEBOOK_REDIRECT_URI;

if (facebookAppId && facebookAppSecret && facebookRedirectUri) {
    type FacebookDone = Parameters<VerifyFunction>[3];

    passport.use(new FacebookStrategy({
      clientID: facebookAppId,
      clientSecret: facebookAppSecret,
      callbackURL: facebookRedirectUri,
      profileFields: ['id', 'displayName', 'photos', 'email'],
    },
    async (
      accessToken: string,
      refreshToken: string,
      profile: FacebookProfile,
      done: FacebookDone
    ) => {
      try {
        let user = await User.findOne({ 'socialProvider.id': profile.id });

        if (user) {
          return done(null, user);
        }

        user = await User.findOne({ email: profile.emails?.[0].value });

        if (user) {
          user.socialProvider = {
            name: 'facebook',
            id: profile.id,
          };
          await user.save();
          return done(null, user);
        }

        const newUser = new User({
          username: profile.displayName,
          email: profile.emails?.[0].value,
          avatarUrl: profile.photos?.[0].value,
          socialProvider: {
            name: 'facebook',
            id: profile.id,
          },
        });

        await newUser.save();
        done(null, newUser);
      } catch (err) {
        done(err as Error);
      }
    }
  ));
}

passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  User.findById(id, (err: any, user: any) => done(err, user));
});
